const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000, ADMIN_KEY=process.env.ADMIN_KEY||'change-me-before-launch', DATA=process.env.DATA_FILE||path.join(__dirname,'data.json');
const questionBank=require('./questions.json');
const questions=questionBank.slice(0,30);
let db={venues:[{id:'woolpack',name:process.env.VENUE_NAME||'The Woolpack, Esholt'}],teams:[],answers:{},game:{id:1,status:'waiting',index:-1,startsAt:null,endsAt:null,questionSeconds:15,breakSeconds:20,questions}};
try {let saved=JSON.parse(fs.readFileSync(DATA)); if(saved&&saved.game&&Array.isArray(saved.venues)){db=saved;db.venues=[{id:'woolpack',name:process.env.VENUE_NAME||'The Woolpack, Esholt'}];db.teams=db.teams.filter(t=>t.venueId==='woolpack');if(db.game.status==='waiting'){db.game.questions=questions;db.game.index=-1;db.game.questionSetSelected=false;db.game.questionSeconds=15;db.game.breakSeconds=20;}if(!Number.isInteger(db.game.revealStep))db.game.revealStep=0;}}catch{}
// Persist used question IDs so games rotate through the entire question bank.
if(!Array.isArray(db.usedQuestionIds))db.usedQuestionIds=[];
function drawQuestions(){
 const used=new Set(db.usedQuestionIds);
 if(questionBank.length-used.size<30){db.usedQuestionIds=[];used.clear();}
 const categories=[...new Set(questionBank.map(q=>q.category))];
 const available=questionBank.map((q,i)=>({...q,bankId:i})).filter(q=>!used.has(q.bankId));
 const shuffled=a=>a.sort(()=>Math.random()-.5);
 const picked=[];const pickedIds=new Set();
 // Mix categories: include at least one question from each represented category.
 for(const category of shuffled([...categories])){
  const choice=shuffled(available.filter(q=>q.category===category&&!pickedIds.has(q.bankId)))[0];
  if(choice&&picked.length<30){picked.push(choice);pickedIds.add(choice.bankId);}
 }
 for(const q of shuffled(available.filter(q=>!pickedIds.has(q.bankId)))){
  if(picked.length>=30)break;picked.push(q);pickedIds.add(q.bankId);
 }
 shuffled(picked);db.usedQuestionIds.push(...picked.map(q=>q.bankId));
 return picked.map(({bankId,...q})=>q);
}
// First game gets its own randomised set, not the same first 50 each time.
if(!db.game.questionSetSelected && db.game.status==='waiting' && db.game.index===-1){db.game.questions=drawQuestions();db.game.questionSetSelected=true;}
const clients=new Set();function save(){fs.writeFileSync(DATA,JSON.stringify(db,null,2));}function uid(){return crypto.randomBytes(8).toString('hex');}
function send(res,status,obj){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',d=>{s+=d;if(s.length>100000)reject(Error('Too large'));});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(Error('Invalid JSON'))}})});}
function phase(){
 let g=db.game,now=Date.now(),changed=false;
 if(!Number.isFinite(g.breakSeconds)||g.breakSeconds<0)g.breakSeconds=30;
 // Advance using the scheduled boundary, not the moment a browser polls.
 while(g.endsAt!=null&&now>=g.endsAt){
  if(g.status==='question'){
   g.status='reveal';g.startsAt=g.endsAt;g.endsAt=g.startsAt+4000;changed=true;
  }else if(g.status==='reveal'){
   if(g.index>=g.questions.length-1){g.status='ceremony';g.revealStep=0;g.startsAt=g.endsAt;g.endsAt=g.startsAt+6000;}
   else{g.status='break';g.startsAt=g.endsAt;g.endsAt=g.startsAt+g.breakSeconds*1000;}changed=true;
  }else if(g.status==='break'){
   if(g.index>=g.questions.length-1){g.status='ceremony';g.revealStep=0;g.startsAt=g.endsAt;g.endsAt=g.startsAt+6000;}
   else{g.index++;g.status='question';g.startsAt=g.endsAt;g.endsAt=g.startsAt+g.questionSeconds*1000;}
   changed=true;
  }else if(g.status==='ceremony'){
   if((g.revealStep||0)<3){g.revealStep=(g.revealStep||0)+1;g.startsAt=g.endsAt;g.endsAt=g.startsAt+6000;}
   else{g.status='finished';g.startsAt=g.endsAt;g.endsAt=null;}
   changed=true;
  }else break;
 }
 if(changed){save();broadcast();}return g.status;
}
function scores(){return db.teams.filter(t=>t.gameId===db.game.id).map(t=>({id:t.id,name:t.name,venueId:t.venueId,score:t.score})).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));}
function state(teamId,admin=false){phase();let g=db.game;let q=g.questions[g.index];let published=g.status==='finished';let a=['question','reveal'].includes(g.status)&&q?{q:q.q,a:q.a,...(g.status==='reveal'?{correct:q.correct}:{})}:null;let team=db.teams.find(t=>t.id===teamId&&t.gameId===g.id);let ranked=scores();let winners=ranked.slice(0,3).map((t,i)=>({...t,place:i+1}));let step=g.revealStep||0;let podium=step===0?[]:winners.filter(w=>w.place>=4-step).sort((x,y)=>y.place-x.place);return {serverTime:Date.now(),gameId:g.id,status:g.status,index:g.index,total:g.questions.length,endsAt:g.endsAt,question:a,venues:db.venues,revealStep:step,podium:g.status==='ceremony'||published?podium:[],leaderboard:published?ranked:[],team:team?{id:team.id,name:team.name,venueId:team.venueId,score:published?team.score:null,answered:!!db.answers[g.id+':'+g.index+':'+team.id]}:null,answerKey:published?g.questions.map((item,i)=>({number:i+1,question:item.q,answer:item.a[item.correct]})):null,...(admin?{admin:true,questionSeconds:g.questionSeconds,breakSeconds:g.breakSeconds,privateLeaderboard:g.status==='ceremony'?ranked:[]}:{} )};}
function broadcast(){for(let c of clients){try{c.write('data: update\n\n')}catch{clients.delete(c)}}}
function isAdmin(req){return req.headers['x-admin-key']===ADMIN_KEY;}
function clean(v,max=50){return String(v||'').trim().slice(0,max).replace(/[<>]/g,'');}
const server=http.createServer(async(req,res)=>{let url=new URL(req.url,'http://localhost');try{
 if(url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('data: connected\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
 if(url.pathname==='/api/state'&&req.method==='GET')return send(res,200,state(url.searchParams.get('teamId'),isAdmin(req)));
 if(url.pathname==='/api/join'&&req.method==='POST'){let b=await body(req),v=db.venues[0],name=clean(b.name);if(!v||name.length<2)return send(res,400,{error:'Choose a venue and a team name of at least 2 characters.'});if(['ceremony','finished'].includes(db.game.status))return send(res,400,{error:'The quiz has finished. Please wait for the next game.'});if(db.teams.some(t=>t.gameId===db.game.id&&t.venueId===v.id&&t.name.toLowerCase()===name.toLowerCase()))return send(res,409,{error:'That team name is already in use at this venue.'});let t={id:uid(),gameId:db.game.id,venueId:v.id,name,score:0};db.teams.push(t);save();broadcast();return send(res,200,{teamId:t.id});}
 if(url.pathname==='/api/answer'&&req.method==='POST'){let b=await body(req);phase();let g=db.game,t=db.teams.find(t=>t.id===b.teamId&&t.gameId===g.id);if(!t)return send(res,403,{error:'Join this game first.'});if(g.status!=='question'||Date.now()>=g.endsAt)return send(res,409,{error:'Answers are closed.'});let choice=Number(b.choice),key=g.id+':'+g.index+':'+t.id;if(!Number.isInteger(choice)||choice<0||choice>3)return send(res,400,{error:'Invalid answer.'});if(db.answers[key])return send(res,409,{error:'Answer already submitted.'});let correct=choice===g.questions[g.index].correct;db.answers[key]={choice,at:Date.now(),correct};if(correct)t.score+=100;save();broadcast();return send(res,200,{ok:true});}
 if(url.pathname.startsWith('/api/admin/')){if(!isAdmin(req))return send(res,401,{error:'Incorrect admin key.'});if(req.method!=='POST')return send(res,405,{error:'POST required'});let b=await body(req),action=url.pathname.split('/').pop(),g=db.game;
 if(action==='venue'){return send(res,403,{error:'This edition supports one venue only.'});}
 else if(action==='start'){if(g.status==='question')return send(res,409,{error:'Question already live.'});if(['ceremony','finished'].includes(g.status))return send(res,409,{error:'Reset for a new game first.'});if(g.index>=g.questions.length-1)return send(res,409,{error:'No questions remaining.'});g.index++;g.status='question';g.startsAt=Date.now();g.endsAt=g.startsAt+g.questionSeconds*1000;}
 
 else if(action==='reveal'){return send(res,409,{error:'The winners are announced automatically after question 30.'});}
 else if(action==='publish'){return send(res,409,{error:'The leaderboard appears automatically after the winners are announced.'});}
 else if(action==='finish'){return send(res,409,{error:'The quiz finishes automatically after question 30.'});}
 else if(action==='settings'){if(g.status!=='waiting')return send(res,409,{error:'Change timers before the quiz begins.'});let qs=Number(b.questionSeconds),bs=Number(b.breakSeconds);if(!Number.isInteger(qs)||qs<5||qs>300||!Number.isInteger(bs)||bs<5||bs>300)return send(res,400,{error:'Timers must be whole seconds from 5 to 300.'});g.questionSeconds=qs;g.breakSeconds=bs;}
 else if(action==='reset'){db.game={id:g.id+1,status:'waiting',index:-1,startsAt:null,endsAt:null,questionSeconds:15,breakSeconds:20,questions:drawQuestions(),questionSetSelected:true,revealStep:0};db.answers={};db.teams=[];}
 else return send(res,404,{error:'Unknown action'});save();broadcast();return send(res,200,{ok:true});}
 if(req.method!=='GET')return send(res,405,{error:'Method not allowed'});
 let p=url.pathname==='/'?'/index.html':url.pathname;let file=path.resolve(__dirname,'public','.'+p);if(!file.startsWith(path.join(__dirname,'public')+path.sep))return send(res,403,{error:'Forbidden'});fs.readFile(file,(err,data)=>{if(err)return send(res,404,{error:'Not found'});let ext=path.extname(file);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml'})[ext]||'application/octet-stream'});res.end(data);});
 }catch(e){send(res,400,{error:e.message||'Request failed'});}});
setInterval(()=>{phase();for(let c of clients){try{c.write(': ping\n\n')}catch{clients.delete(c)}}},3000);
save();server.listen(PORT,()=>console.log('Single Venue Quiz on http://localhost:'+PORT+' | Set ADMIN_KEY before deploying'));
