(() => {
  const cfg=window.APP_CONFIG||{};
  const view=document.getElementById('admin-view');
  const countEl=document.getElementById('admin-listeners');
  const sb=window.supabase?.createClient(cfg.SUPABASE_URL||'',cfg.SUPABASE_ANON_KEY||'');
  let session=null, sessions=[], tracks=[], channel=null, countdownTimer=null;

  function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  function t(x,f){return x[`${f}_en`]||x[`${f}_es`]||'';}
  function sessionName(s){
    if(s.slug==='presentation') return 'Presentation';
    if(s.slug==='listening') return 'Post-listening';
    return s.title || s.slug;
  }

  async function init(){
    if(!sb){error('Configura config.js.');return;}
    const {data:{session:s}}=await sb.auth.getSession();
    if(!s){renderLogin();return;}
    await load();
    subscribe();
    presence();
    startCountdownWatcher();
  }
  function error(m){view.innerHTML=`<div class="admin-login"><div class="notice error">${esc(m)}</div></div>`;}
  function renderLogin(){
    view.innerHTML=`<section class="admin-login"><div class="kicker">ADMIN</div><h1>Sign in</h1><form id="login" class="form-grid"><input type="email" name="email" required placeholder="Email"><input type="password" name="password" required placeholder="Password"><button class="submit">Sign in</button></form><p class="meta">The account must also exist in the <code>admins</code> table.</p></section>`;
    document.getElementById('login').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);const {error}=await sb.auth.signInWithPassword({email:fd.get('email'),password:fd.get('password')});if(error)errorBox(error.message);else init();};
  }
  function errorBox(m){const n=document.querySelector('.notice');if(n)n.textContent=m;else view.insertAdjacentHTML('afterbegin',`<div class="notice error">${esc(m)}</div>`);}

  async function load(){
    const {data:all,error:sErr}=await sb.from('session_state').select('*').order('slug');
    if(sErr){error(sErr.message);return;}
    sessions=all||[];
    session=sessions.find(x=>x.is_active) || sessions[0] || null;
    if(!session){error('No listening sessions configured.');return;}
    await loadTracks();
    render();
  }
  async function loadTracks(){
    const {data,error}=await sb.from('tracks').select('*').eq('session_slug',session.slug).order('position');
    if(error){errorBox(error.message);tracks=[];return;}
    tracks=data||[];
  }
  function subscribe(){
    if(channel)sb.removeChannel(channel);
    channel=sb.channel('admin-session-state')
      .on('postgres_changes',{event:'*',schema:'public',table:'session_state'},async()=>{
        const {data:all}=await sb.from('session_state').select('*').order('slug');
        sessions=all||sessions;
        const active=sessions.find(x=>x.is_active);
        if(active && active.slug===session.slug){session=active;await loadTracks();render();}
        else if(active){session=active;await loadTracks();presence();render();}
      })
      .subscribe();
  }
  function presence(){
    const name=`listeners-${session?.slug||'presentation'}`;
    const old=window.__adminPresenceChannel;
    if(old) sb.removeChannel(old);
    const ch=sb.channel(name,{config:{presence:{key:'admin-'+crypto.randomUUID()}}});
    window.__adminPresenceChannel=ch;
    ch.on('presence',{event:'sync'},()=>{countEl.textContent=`${Object.keys(ch.presenceState()).length} listeners`;});
    ch.subscribe();
  }
  function localDateTimeValue(iso){
    if(!iso) return '';
    const d=new Date(iso); if(Number.isNaN(d.getTime())) return '';
    const pad=n=>String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function startCountdownWatcher(){
    if(countdownTimer) clearInterval(countdownTimer);
    countdownTimer=setInterval(async()=>{
      if(!session?.countdown_enabled || !session?.countdown_target_at || session.status!=='draft') return;
      const target=new Date(session.countdown_target_at).getTime();
      if(Number.isNaN(target) || Date.now()<target) return;
      const {error}=await sb.from('session_state').update({status:'live',current_position:1,countdown_enabled:false,countdown_target_at:null}).eq('slug',session.slug).eq('status','draft');
      if(!error){session={...session,status:'live',current_position:1,countdown_enabled:false,countdown_target_at:null};render();}
    },1000);
  }
  function render(){
    if(!session)return;
    const current=tracks.find(x=>x.position===session.current_position);
    view.innerHTML=`<section class="admin-panel">
      <div class="grid-head"><div><div class="kicker">ADMIN</div><h2>Session control</h2></div><button id="logout" class="text-button">Sign out</button></div>
      <div class="admin-dashboard">
        <div class="admin-session-select"><label><span class="kicker">PUBLIC SESSION</span><select id="session-select">${sessions.map(s=>`<option value="${esc(s.slug)}" ${s.slug===session.slug?'selected':''}>${esc(sessionName(s))}</option>`).join('')}</select></label><div class="meta">The selected session is the one shown to the public.</div></div>
        <div class="notice">Status: <strong>${esc(session.status)}</strong> · Current position: <strong>${session.current_position||0}</strong> / ${tracks.length} · Session: <strong>${esc(sessionName(session))}</strong></div>
        ${current?`<div class="admin-current"><img src="${esc(current.cover_url)}"><div><div class="kicker">NOW PLAYING · ${current.position}</div><h2>${esc(t(current,'title'))}</h2><div>${esc(t(current,'artist'))}</div></div></div>`:''}
        <div class="admin-controls"><button data-action="start">Start</button><button data-action="prev">← Previous</button><button data-action="next">Next →</button><button data-action="end" class="danger">End session</button><button data-action="reset">Reset session</button></div>
        <div class="countdown-admin"><div><div class="kicker">COUNTDOWN</div><h3>Intro countdown</h3><p class="meta">It appears at the end of the public introduction and starts this session automatically.</p></div><label class="checkline"><input id="countdown-enabled" type="checkbox" ${session.countdown_enabled?'checked':''}> Enabled</label><div class="countdown-settings"><input id="countdown-target" type="datetime-local" value="${localDateTimeValue(session.countdown_target_at)}"><button id="save-countdown" class="submit" type="button">Save countdown</button></div></div>
        <div class="admin-list">${tracks.map(x=>`<div class="admin-row"><span class="num">${String(x.position).padStart(2,'0')}</span><img src="${esc(x.cover_url)}"><div class="title">${esc(t(x,'artist'))}<br><small>${esc(t(x,'title'))}</small></div><button data-jump="${x.position}">Jump</button></div>`).join('')}</div>
      </div>
    </section>`;
    bind();
  }
  async function update(p,status=null){
    const patch={current_position:p};
    if(status)patch.status=status;
    const {error}=await sb.from('session_state').update(patch).eq('slug',session.slug);
    if(error)alert(error.message);
  }
  async function resetSession(){
    const {error}=await sb.from('session_state').update({status:'draft',current_position:0,countdown_enabled:false,countdown_target_at:null}).eq('slug',session.slug);
    if(error){alert(error.message);return;}
    session={...session,status:'draft',current_position:0,countdown_enabled:false,countdown_target_at:null};
    render();
  }
  async function selectSession(slug){
    if(slug===session.slug)return;
    const {error}=await sb.rpc('set_active_session',{p_slug:slug});
    if(error){alert(error.message);return;}
    const selected=sessions.find(x=>x.slug===slug);
    if(selected)session={...selected,is_active:true};
    sessions=sessions.map(x=>({...x,is_active:x.slug===slug}));
    await loadTracks();
    presence();
    render();
  }
  function bind(){
    document.getElementById('logout').onclick=async()=>{await sb.auth.signOut();renderLogin();};
    const sel=document.getElementById('session-select');
    if(sel)sel.onchange=()=>selectSession(sel.value);
    document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{const a=b.dataset.action;if(a==='start')await update(1,'live');if(a==='prev')await update(Math.max(1,(session.current_position||1)-1),'live');if(a==='next')await update(Math.min(tracks.length,(session.current_position||0)+1),'live');if(a==='end')await update(session.current_position||tracks.length,'finished');if(a==='reset')await resetSession();});
    document.querySelectorAll('[data-jump]').forEach(b=>b.onclick=()=>update(Number(b.dataset.jump),'live'));
    const save=document.getElementById('save-countdown');
    if(save)save.onclick=async()=>{
      const enabled=document.getElementById('countdown-enabled').checked;
      const raw=document.getElementById('countdown-target').value;
      if(enabled&&!raw){alert('Choose a date and time for the countdown.');return;}
      const target=raw?new Date(raw).toISOString():null;
      const {error}=await sb.from('session_state').update({countdown_enabled:enabled,countdown_target_at:target}).eq('slug',session.slug);
      if(error)alert(error.message);else{session.countdown_enabled=enabled;session.countdown_target_at=target;render();}
    };
  }
  init();
})();
