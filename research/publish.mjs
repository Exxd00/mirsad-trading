import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname,join } from 'node:path';
const repo=process.env.GITHUB_REPOSITORY,token=process.env.GITHUB_TOKEN;
if(!repo||!/^[-\w]+\/[-.\w]+$/.test(repo)||!token)throw Error('GitHub workflow identity required');
const dir=dirname(fileURLToPath(import.meta.url));
const branch='mirsad-paper-results';
async function api(path,method='GET',body){
 const r=await fetch(`https://api.github.com/repos/${repo}/${path}`,{method,redirect:'error',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},...(body?{body:JSON.stringify(body)}:{})});
 if(r.status===404)return null;
 if(!r.ok)throw Error(`GitHub ${method} failed: ${r.status}`);
 return r.status===204?{}:r.json();
}
let ref=await api('git/ref/heads/'+branch);
if(!ref){
 const source=await api('git/ref/heads/main');
 ref=await api('git/refs','POST',{ref:'refs/heads/'+branch,sha:source.object.sha});
}
// Only public-price research outputs go to this branch. Never copy .env or app data.
const previous=await api(`contents/research/output/latest.json?ref=${branch}`);
const report=JSON.parse(await fs.readFile(join(dir,'output/latest.json'),'utf8'));
if(report.mode!=='paper-research'||!['ok','unavailable'].includes(report.status))throw Error('Invalid report');
report.sourceCommit=process.env.GITHUB_SHA;
report.workflowRun=`https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const result=await api('contents/research/output/latest.json','PUT',{message:'Update public paper research report',branch,
 ...(previous?.sha?{sha:previous.sha}:{}),content:Buffer.from(JSON.stringify(report,null,2)+'\n').toString('base64')});
console.log('Published paper report: '+result.content.html_url);
