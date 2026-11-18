import { element } from './dom.js';
const format = value => value.toLocaleString(undefined,{maximumFractionDigits:6});
const categories = [['uncached','Input without cache reads'],['cached','Cached input'],['output','Output']];
function svgNode(tag, attrs={}, text) {
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
  if(text!==undefined)node.textContent=text;
  return node;
}
export function renderUsageChart(container, report, {metric='total',style='bar'}={}) {
  container.replaceChildren();
  const cost=metric==='cost', tools=metric==='tools';
  const series=cost?[['cost','Recorded USD']]:tools?[['tools','Tool events']]:categories;
  const available=cost?report.costReports:tools?report.toolCount:report.usageReports;
  if(!available) {
    container.append(element('p','metrics-empty',cost?'Cost unavailable. Local usage records do not provide additive USD costs. No token-price estimates or subscription charges are inferred.':tools?'No tool activity recorded in this period.':'No token usage recorded in this period.'));
    return;
  }
  const legend=element('div','chart-legend');
  for(const [key,label] of series){const item=element('span');item.append(element('i',`swatch series-${key}`),document.createTextNode(label));legend.append(item);}
  container.append(legend);
  const points=report.points, w=760,h=250,p={l:90,r:20,t:22,b:42}, inner=w-p.l-p.r;
  const value=point=>cost?point.cost:tools?point.tools:point.total;
  const max=Math.max(1e-9,...points.map(value));
  const x=i=>p.l+(i+.5)/points.length*inner, y=v=>h-p.b-v/max*(h-p.t-p.b);
  const svg=svgNode('svg',{viewBox:`0 0 ${w} ${h}`,class:'metrics-chart',role:'group','aria-label':cost?'Recorded cost in USD':tools?'Tool events over time':'Token composition over time'});
  for(let i=0;i<=4;i++){
    const v=max*i/4;
    svg.append(svgNode('line',{x1:p.l,x2:w-p.r,y1:y(v),y2:y(v),class:'chart-grid'}),svgNode('text',{x:p.l-10,y:y(v)+4,'text-anchor':'end',class:'chart-label'},cost?`$${format(v)}`:Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(v)));
  }
  const info=element('p','chart-readout','Hover or focus a mark for exact values.');info.setAttribute('aria-live','polite');
  const labels=[];
  for(let i=0;i<points.length;i++) {
    const point=points[i];
    const date=new Date(point.at*1000).toLocaleString(undefined,{month:'short',day:'numeric',year:report.step>86400?'numeric':undefined,hour:report.step===3600?'numeric':undefined,timeZoneName:report.step===3600?'short':undefined});
    const label=`${date}: ${series.map(([key,name])=>`${name} ${format(point[key])}${cost?' USD':''}`).join(' · ')}${cost?` · ${point.costReports}/${point.usageReports} usage reports covered`:''}`;
    labels.push(label);
    // Missing cost buckets are gaps, never zero-dollar observations.
    if(cost&&!point.costReports)continue;
    let baseline=0;
    for(const [key] of series) {
      const v=point[key];
      const mark=style==='bar'?svgNode('rect',{x:x(i)-inner/points.length*.36,y:y(baseline+v),width:inner/points.length*.72,height:Math.max(v?1:0,y(baseline)-y(baseline+v)),class:`series-${key}`}):svgNode('circle',{cx:x(i),cy:y(v),r:3.5,class:`series-${key}`});
      mark.setAttribute('tabindex','0');mark.setAttribute('aria-label',label);mark.append(svgNode('title',{},label));
      mark.addEventListener('focus',()=>info.textContent=label);mark.addEventListener('mouseenter',()=>info.textContent=label);
      svg.append(mark);baseline+=v;
    }
  }
  if(style==='line') for(const [key] of series){
    let segment=[];
    const flush=()=>{if(segment.length)svg.prepend(svgNode('polyline',{points:segment.join(' '),class:`series-line series-stroke-${key}`}));segment=[];};
    points.forEach((point,i)=>{if(cost&&!point.costReports)flush();else segment.push(`${x(i)},${y(point[key])}`);});flush();
  }
  for(const i of new Set([0,Math.floor((points.length-1)/2),points.length-1])) svg.append(svgNode('text',{x:x(i),y:h-12,'text-anchor':i===0?'start':i===points.length-1?'end':'middle',class:'chart-label'},new Date(points[i].at*1000).toLocaleString(undefined,report.step===3600?{hour:'numeric'}:{month:'short',day:'numeric',year:report.step>86400?'2-digit':undefined})));
  const details=element('details','chart-data');details.append(element('summary','','Exact chart values'));
  const wrap=element('div','metrics-table-wrap'), table=element('table','metrics-table'), head=element('thead'), header=element('tr');
  for(const label of ['Bucket starts (local time)',...series.map(([,name])=>name),...(cost?['Coverage']:[])]){const th=element('th','',label);th.scope='col';header.append(th);}head.append(header);table.append(head);
  const body=element('tbody');
  for(const point of points){const row=element('tr');row.append(element('td','',new Date(point.at*1000).toLocaleString()));for(const [key] of series)row.append(element('td','',cost&&!point.costReports?'Unavailable':format(point[key])));if(cost)row.append(element('td','',`${point.costReports}/${point.usageReports} reports`));body.append(row);}
  table.append(body);wrap.append(table);details.append(wrap);container.append(svg,info,details);
}
