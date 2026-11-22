import { icon } from './ui.js';
import { renderUsageChart } from './usage-chart.js';
import { renderOutcomesChart } from './outcomes-chart.js';
import { element } from './dom.js';
import { normalizeMetrics, summarizeMetrics, summarizeJobRuns } from '../core/metrics.js';
import { getHarness } from '../core/catalog.js';
const $ = selector=>document.querySelector(selector);
const number = value=>value.toLocaleString();
export function initActivityMetrics({fetchMetrics, fetchJobRuns, native}) {
  let rows=[],jobRuns=[],jobError='',loading=false,hasData=!native;
  const harness=$('#metrics-harness'),model=$('#metrics-model'),range=$('#metrics-range'),metric=$('#metrics-value'),style=$('#metrics-style');
  // The period (top of the page, shared by every chart) and the chart type are remembered on this device.
  const saved=['metrics-range','metrics-style','metrics-outcomes-style'];
  for(const id of saved){try{const value=localStorage.getItem(`noai.${id}`);const node=$(`#${id}`);if(value&&[...node.options].some(option=>option.value===value))node.value=value;}catch{/* storage unavailable */}}
  function options() {
    const selectedHarness=harness.value,selectedModel=model.value;
    const harnesses=[...new Set(rows.map(row=>row.harness))].sort();
    harness.replaceChildren(new Option('All harnesses',''),...harnesses.map(id=>new Option(getHarness(id)?.label || id,id)));
    harness.value=harnesses.includes(selectedHarness)?selectedHarness:'';
    const models=[...new Set(rows.filter(row=>!harness.value || row.harness===harness.value).map(row=>row.model || '__default__'))].sort();
    model.replaceChildren(new Option('All models',''),...models.map(id=>new Option(id==='__default__'?'Harness default / not reported':id,id)));
    model.value=models.includes(selectedModel)?selectedModel:'';
  }
  function render() {
    for(const node of document.querySelectorAll('#view-home .metrics-totals, #view-home .metrics-insights, #view-home .metrics-job-summary, #view-home .metrics-figure, #view-home .metrics-tools-section, #view-home .metrics-daily-section, #view-home .metrics-table-wrap'))node.hidden=!hasData;
    const filters={harness:harness.value,model:model.value,range:range.value};
    const report=summarizeMetrics(rows,filters);
    const jobs=summarizeJobRuns(jobRuns,filters);
    $('#metrics-job-summary').textContent=jobError || `${jobs.total} Noai occurrences across ${jobs.jobs} jobs · ${jobs.completed} succeeded · ${jobs.failed} failed · ${jobs.waiting} waiting · ${jobs.running} running · ${jobs.other} other. Selected by start time; each occurrence counted once, including its resumes.`;
    const cards=$('#metrics-totals');cards.replaceChildren();
    const compactNumber=value=>Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(value);
    for(const [label,value,note,kind,color,title] of [
      ['Tokens',report.usageReports?compactNumber(report.tokens):'—',report.usageReports?`${compactNumber(report.input)} in · ${compactNumber(report.output)} out`:'Waiting for CLI usage data','bolt','var(--tile-home)',report.usageReports?`${number(report.tokens)} reported tokens`:''],
      ['Cache hits',report.cacheRate===null?'—':`${(report.cacheRate*100).toFixed(1)}%`,'Cached reads ÷ all input','stack','var(--tile-chat)',''],
      ['Cost',report.cost===null?'—':`$${report.cost.toLocaleString(undefined,{maximumFractionDigits:2})}`,report.cost===null?'Not reported by your agents':`${report.costReports} / ${report.usageReports} reports priced · USD`,'coin','var(--tile-accounts)',''],
      ['Sessions',number(report.runs),'Agent sessions and Noai runs','chat','var(--tile-jobs)','']
    ]) {const card=element('div','ui-filter ui-stat metrics-stat');card.style.setProperty('--filter',color);const top=element('span','ui-filter-top'),mark=element('span','ui-filter-icon');mark.append(icon(kind));const strong=element('strong','metrics-stat-value',value);if(title)strong.title=title;top.append(mark,strong);card.append(top,element('span','ui-filter-label metric-label',label),element('small','',note));cards.append(card);}
    const usageReport=report;
    renderUsageChart($('#metrics-chart'),usageReport,{metric:metric.value,style:style.value});
    renderOutcomesChart($('#metrics-outcomes'),report,{style:$('#metrics-outcomes-style').value});
    const insights=$('#metrics-insights');insights.replaceChildren();
    for(const [label,group] of [['Most-used model',report.models[0]],['Most-used harness',report.harnesses[0]]]) {
      const card=element('div','insight-card');
      card.append(element('span','metric-label',label),element('strong','',group?.tokens ? (getHarness(group.name)?.label || group.name) : 'Not reported'),element('p','',group?.tokens?`${(group.tokens/Math.max(1,report.tokens)*100).toFixed(1)}% of recorded tokens in this selection`:'Measured by input + output tokens'));
      insights.append(card);
    }
    const change=report.comparison, card=element('div','insight-card');
    card.append(element('span','metric-label','Compared with preceding period'),element('strong','',!change?'All-time view':`${change.absolute>=0?'+':''}${number(change.absolute)} tokens`),element('p','',!change?'Choose a shorter period to compare.':change.percent===null?'No recorded baseline; percentage unavailable.':`${change.percent>=0?'+':''}${change.percent.toFixed(1)}% · previous ${number(report.previous)} tokens`));insights.append(card);
    $('#metrics-chart-caption').textContent=`${usageReport.step===3600?'Hourly':usageReport.step===86400?'Daily':`${usageReport.step/86400}-day`} totals in your local timezone · Partial first/last buckets. Input without cache reads includes cache writes when not separately recorded.${usageReport.baselineOnly?' Resumed sessions without a prior reading establish a baseline first.':''}`;
    const daily=$('#metrics-daily');daily.replaceChildren();
    for(const day of report.daily) {
      const row=element('tr');
      for(const value of [new Date(day.at*1000).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}),number(day.input),number(day.output),number(day.cached),number(day.total),number(day.tools)])row.append(element('td','',value));
      daily.append(row);
    }
    $('#metrics-daily-empty').hidden=report.daily.length>0;
    const tools=$('#metrics-tools');tools.replaceChildren();
    if(!report.tools.length) tools.append(element('p','metrics-empty','No tool events in this selection.'));
    for(const tool of report.tools.slice(0,12)) {
      const row=element('div','metrics-tool');const label=element('div','metrics-tool-label');label.append(element('span','',tool.name),element('strong','',number(tool.count)));
      const bar=element('meter','metrics-tool-meter');bar.min=0;bar.max=Math.max(1,report.toolCount);bar.value=tool.count;bar.setAttribute('aria-label',`${tool.name}: ${tool.count} events`);row.append(label,bar);tools.append(row);
    }
    const body=$('#metrics-breakdown');body.replaceChildren();
    for(const group of report.groups) {
      const row=element('tr');for(const value of [getHarness(group.harness)?.label||group.harness,group.model||'Harness default / not reported',group.reported?number(group.tokens):'Not reported',number(group.tools),number(group.runs)])row.append(element('td','',value));body.append(row);
    }
    $('#metrics-breakdown-empty').hidden=report.groups.length>0;
  }
  async function refresh() {
    if(loading)return;
    if(!native){$('#metrics-status').textContent='Desktop required · Metrics use local agent history and Noai activity.';render();return;}
    loading=true;$('#metrics-refresh').disabled=true;$('#metrics-status').textContent='Loading local history…';
    try {
      const [data,jobData]=await Promise.all([fetchMetrics(),fetchJobRuns ? fetchJobRuns().then(runs=>({runs})).catch(error=>({error:String(error)})) : Promise.resolve({runs:[]})]);
      jobRuns=jobData.runs || [];jobError=jobData.error ? `Job statistics unavailable: ${jobData.error}` : '';rows=normalizeMetrics(data.records||[]);hasData=rows.length>0 || !data.importStatus?.scanning;options();render();
      const importStatus=data.importStatus;
      const source=importStatus?.scanning?'Scanning local agent history and Noai activity':`Local agent history${importStatus?.files!=null?` (${number(importStatus.files)} files scanned)`:''} and Noai activity`;
      const errors=importStatus?.errors?` · ${number(importStatus.errors)} history files could not be read`:'';
      $('#metrics-status').textContent=`Updated ${new Date().toLocaleTimeString()} · ${source}. Counts use reported usage, not remaining subscription quota.${errors}${importStatus?.parseErrors ? ` · ${number(importStatus.parseErrors)} candidate metric records could not be parsed` : ''}`;
    }
    catch(error){$('#metrics-status').textContent=`Cannot refresh metrics; any visible values are from the last successful load: ${String(error)}`;}
    finally {loading=false;$('#metrics-refresh').disabled=false;}
  }
  harness.addEventListener('change',()=>{model.value='';options();render();});
  for(const node of [model,range,metric,style,$('#metrics-outcomes-style')])node.addEventListener('change',render);
  for(const id of saved)$(`#${id}`).addEventListener('change',event=>{try{localStorage.setItem(`noai.${id}`,event.target.value);}catch{/* storage unavailable */}});
  $('#metrics-refresh').addEventListener('click',()=>void refresh());render();
  return {refresh};
}
