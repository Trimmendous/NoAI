//! An agent CLI described by a plugin (`agents` in plugin.json). The prompt
//! goes to stdin like every agent; output is plain text lines or JSON lines
//! with a text field. Plugin agents have no usage, history or bypass mode.
use super::{BoxFuture, Harness, Permission};
use crate::adapters::{JobPermissions, RunEvent, RunRequest};
use crate::plugins::AgentSpec;
use crate::providers::{HarnessModel, ProviderUsageSnapshot};
use serde_json::Value;

const PERMISSIONS: &[Permission] = &[Permission {
    id: JobPermissions::ProviderDefault,
    label: "The agent's own settings",
    description:
        "Noai runs the command as the plugin describes it; whatever that CLI allows is allowed.",
}];

pub struct PluginAgent {
    id: &'static str,
    label: &'static str,
    command: &'static str,
    spec: AgentSpec,
}

impl PluginAgent {
    pub fn new(spec: AgentSpec) -> Self {
        let leak = |text: &str| -> &'static str { Box::leak(text.to_owned().into_boxed_str()) };
        Self {
            id: leak(&spec.id),
            label: leak(&spec.label),
            command: leak(&spec.command),
            spec,
        }
    }

    fn text_event(&self, request: &RunRequest, text: String) -> Vec<RunEvent> {
        if text.is_empty() {
            return Vec::new();
        }
        vec![RunEvent::new(request, "text", Some(text))]
    }
}

impl Harness for PluginAgent {
    fn id(&self) -> &'static str {
        self.id
    }
    fn label(&self) -> &'static str {
        self.label
    }
    fn executable(&self) -> &'static str {
        self.command
    }
    fn permissions(&self) -> &'static [Permission] {
        PERMISSIONS
    }
    fn read_only(&self) -> JobPermissions {
        JobPermissions::ProviderDefault
    }
    fn bypass_description(&self) -> &'static str {
        "Plugin agents have no permission bypass."
    }
    fn args(&self, request: &RunRequest) -> Vec<String> {
        let fill = |arg: &String| {
            arg.replace("{model}", request.model.as_deref().unwrap_or_default())
                .replace("{project}", &request.project_path)
        };
        let mut args: Vec<String> = self.spec.args.iter().map(fill).collect();
        if request
            .model
            .as_deref()
            .is_some_and(|model| !model.is_empty())
        {
            args.extend(self.spec.model_args.iter().map(fill));
        }
        args
    }
    fn parse(&self, request: &RunRequest, value: &Value) -> Vec<RunEvent> {
        let field = self.spec.text_field.as_deref().unwrap_or("text");
        match value.get(field).and_then(Value::as_str) {
            Some(text) => self.text_event(request, text.to_owned()),
            None => Vec::new(),
        }
    }
    fn parse_text(&self, request: &RunRequest, line: &str) -> Option<Vec<RunEvent>> {
        // Text agents: every line is part of the reply, JSON-looking or not.
        (self.spec.output != "jsonl").then(|| self.text_event(request, line.trim_end().to_owned()))
    }
    fn models(&self) -> BoxFuture<Vec<HarnessModel>> {
        let models = self
            .spec
            .models
            .iter()
            .map(|id| HarnessModel {
                id: id.clone(),
                label: id.clone(),
                source: "agent",
            })
            .collect();
        Box::pin(async move { models })
    }
    fn usage(&self) -> BoxFuture<ProviderUsageSnapshot> {
        let snapshot =
            crate::providers::unavailable(self.id, self.label, "Plugin agents don't report usage.");
        Box::pin(async move { snapshot })
    }
    fn identity(&self) -> BoxFuture<Option<String>> {
        Box::pin(async { None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(output: &str) -> PluginAgent {
        PluginAgent::new(AgentSpec {
            id: "plugin-echo".into(),
            label: "Echo".into(),
            command: "cat".into(),
            args: vec!["--dir".into(), "{project}".into()],
            model_args: vec!["--model".into(), "{model}".into()],
            models: vec![],
            output: output.into(),
            text_field: Some("say".into()),
        })
    }

    #[test]
    fn plugin_agents_fill_their_arguments_and_read_their_output() {
        let mut request = RunRequest {
            run_id: "r".into(),
            conversation_id: "c".into(),
            harness: "plugin-echo".into(),
            model: None,
            project_path: "/p".into(),
            prompt: "hi".into(),
            resume_id: None,
            auto_resume: false,
            dangerously_bypass_permissions: false,
            permissions: None,
        };
        assert_eq!(agent("text").args(&request), ["--dir", "/p"]);
        request.model = Some("m1".into());
        assert_eq!(
            agent("text").args(&request),
            ["--dir", "/p", "--model", "m1"]
        );
        assert_eq!(
            agent("text").parse_text(&request, "hello\n").unwrap()[0]
                .text
                .as_deref(),
            Some("hello")
        );
        assert!(agent("jsonl").parse_text(&request, "{}").is_none());
        assert_eq!(
            agent("jsonl").parse(&request, &serde_json::json!({"say":"hi"}))[0]
                .text
                .as_deref(),
            Some("hi")
        );
    }
}
