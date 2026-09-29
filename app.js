(() => {
  const cfg = window.APP_CONFIG || {};
  const view = document.getElementById('view');
  const countEl = document.getElementById('listener-count');
  const langBtn = document.getElementById('lang-toggle');
  const supabase = window.supabase?.createClient(cfg.SUPABASE_URL || '', cfg.SUPABASE_ANON_KEY || '');
  const sessionSlug = cfg.SESSION_SLUG || 'main';
  let state = { session:null, tracks:[], lang: getLang(), loading:true, counts:{} };
  let presenceChannel = null;
  let realtimeChannel = null;
  const clientIdKey = 'ls_client_id';
  const clientId = localStorage.getItem(clientIdKey) || crypto.randomUUID();
  localStorage.setItem(clientIdKey, clientId);

  function getLang(){
    const saved = localStorage.getItem('ls_lang');
    if(saved) return saved;
    const browser = navigator.language?.toLowerCase() || 'en';
    return browser.startsWith('es') ? 'es' : 'en';
  }
  function esc(s=''){ return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function text(track, field){ return track[`${field}_${state.lang}`] || track[`${field}_${state.lang==='es'?'en':'es'}`] || ''; }
  function formatListeners(n){ return state.lang==='es' ? `${n} oyentes` : `${n} listeners`; }
  function trackUrl(n){ return `#/track/${n}`; }
  function getCurrent(){ return state.session?.status==='finished' ? null : state.session?.current_position || 0; }
  function isVisible(t){ return state.session?.status==='finished' || t.position <= getCurrent(); }
  function promoHtml(){
    return `<div class="promo"><small>${state.lang==='es'?'Enlaces':'Links'}</small><div class="links"><a class="underlink" href="${esc(cfg.SPOTIFY_PLAYLIST_URL)}" target="_blank" rel="noopener">Spotify playlist ↗</a><a class="underlink" href="${esc(cfg.LINKTREE_URL)}" target="_blank" rel="noopener">Linktree ↗</a></div></div>`;
  }
  function everyTenPromo(position){ return position % 10 === 0 ? promoHtml() : ''; }
  async function load(){
    if(!supabase){ renderError('Configura config.js antes de usar la web.'); return; }
    const [{data:session,error:sErr},{data:tracks,error:tErr}] = await Promise.all([
      supabase.from('session_state').select('*').eq('slug',sessionSlug).single(),
      supabase.from('tracks').select('*').order('position')
    ]);
    if(sErr || tErr){ renderError((sErr||tErr).message); return; }
    state.session=session; state.tracks=tracks; state.loading=false;
    await loadReactionCounts();
    subscribeRealtime(); subscribePresence(); renderRoute();
  }
  async function loadReactionCounts(){
    const trackIds=state.tracks.map(t=>t.id);
    if(!trackIds.length) return;
    const {data:likes}=await supabase.from('likes').select('track_id').in('track_id',trackIds);
    const counts={}; (likes||[]).forEach(x=>counts[x.track_id]=(counts[x.track_id]||0)+1); state.counts.likes=counts;
  }
  function subscribeRealtime(){
    if(realtimeChannel) supabase.removeChannel(realtimeChannel);
    realtimeChannel=supabase.channel(`session-${sessionSlug}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'session_state',filter:`slug=eq.${sessionSlug}`},p=>{ state.session=p.new; renderRoute(); })
      .on('postgres_changes',{event:'*',schema:'public',table:'comments'},()=>renderRoute())
      .on('postgres_changes',{event:'*',schema:'public',table:'likes'},()=>renderRoute())
      .subscribe();
  }
  function subscribePresence(){
    if(presenceChannel) supabase.removeChannel(presenceChannel);
    presenceChannel=supabase.channel(`listeners-${sessionSlug}`,{config:{presence:{key:clientId}}});
    presenceChannel.on('presence',{event:'sync'},()=>updatePresenceCount()).subscribe(async status=>{ if(status==='SUBSCRIBED'){ await presenceChannel.track({online_at:new Date().toISOString()}); updatePresenceCount(); }});
  }
  function updatePresenceCount(){
    const statePresence=presenceChannel?.presenceState?.()||{}; const n=Object.keys(statePresence).length; countEl.textContent=formatListeners(n); }
  async function commentsFor(targetType,trackId){
    let q=supabase.from('comments').select('*').eq('target_type',targetType).order('created_at',{ascending:true}).limit(50);
    q=trackId ? q.eq('track_id',trackId) : q.is('track_id',null);
    const {data}=await q; return data||[];
  }
  async function reactionsHtml(targetType,trackId){
    let q=supabase.from('likes').select('id',{count:'exact',head:true}).eq('target_type',targetType);
    q=trackId?q.eq('track_id',trackId):q.is('track_id',null);
    const {count}=await q; return `<div class="reaction-row"><button class="like-button" data-like="${targetType}" data-track="${trackId||''}">♡ ${count||0}</button></div>`;
  }
  async function commentsHtml(targetType,trackId){
    const cs=await commentsFor(targetType,trackId);
    return `<div class="comments"><div class="comment-list">${cs.map(c=>`<div class="comment"><strong>${esc(c.name)}</strong>${esc(c.body)}</div>`).join('')}</div><form class="comment-form" data-comment-form data-target="${targetType}" data-track="${trackId||''}"><input name="name" maxlength="60" required placeholder="${state.lang==='es'?'Nombre':'Name'}"><textarea name="body" maxlength="500" required placeholder="${state.lang==='es'?'Comentario':'Comment'}"></textarea><button class="submit" type="submit">${state.lang==='es'?'Enviar':'Send'}</button></form></div>`;
  }
  async function renderIntro(){
    const intro=state.session||{};
    const comments=await commentsHtml('intro',null); const reactions=await reactionsHtml('intro',null);
    view.innerHTML=`<section class="intro"><div class="intro-grid"><div class="hero-cover">${intro.intro_cover_url?`<img class="cover" src="${esc(intro.intro_cover_url)}" alt="">`:''}</div><div><div class="kicker">${state.lang==='es'?'Sesión de escucha':'Listening session'}</div><h1>${esc(text(intro,'intro_title')||intro.title||'Listening Session')}</h1><div class="intro-copy dropcap">${esc(text(intro,'intro_text'))}</div>${promoHtml()}<div class="reactions">${reactions}${comments}</div></div></div></section>`;
  }
  function renderGrid(){
    const visible=state.tracks.filter(isVisible); const ended=state.session?.status==='finished';
    const tiles=state.tracks.map(t=>{
      const unlocked=isVisible(t); const current=!ended && t.position===getCurrent();
      if(!unlocked) return `<div class="track-tile locked"><span class="tile-number">${String(t.position).padStart(2,'0')}</span><div class="lock">LOCKED</div></div>`;
      return `<div class="track-tile"><a href="${trackUrl(t.position)}"><div class="tile-cover"><img src="${esc(t.cover_url)}" alt=""></div><div class="tile-overlay"><span class="tile-number">${String(t.position).padStart(2,'0')}</span>${current?'<span class="now-playing"><i></i><i></i><i></i><i></i></span>':''}<div class="tile-info">${esc(text(t,'artist'))}<small>${esc(text(t,'title'))}</small></div></div></a></div>`;
    }).join('');
    view.innerHTML=`<section><div class="grid-head"><div><div class="kicker">${ended?(state.lang==='es'?'Sesión terminada':'Session ended'):(state.lang==='es'?'Tracklist':'Tracklist')}</div><h2>Grid</h2></div><a class="underlink" href="#/intro">${state.lang==='es'?'Inicio':'Intro'}</a></div><div class="track-grid">${tiles}</div>${promoHtml()}</section>`;
  }
  async function renderTrack(position){
    const t=state.tracks.find(x=>x.position===position);
    if(!t || !isVisible(t)){ location.hash='#/grid'; return; }
    const ended=state.session?.status==='finished';
    const prev=state.tracks.find(x=>x.position===position-1 && isVisible(x)); const next=state.tracks.find(x=>x.position===position+1 && isVisible(x));
    const comments=await commentsHtml('track',t.id); const reactions=await reactionsHtml('track',t.id);
    view.innerHTML=`<section class="track-page"><div class="track-topnav"><a class="underlink" href="#/grid">Grid</a><a class="underlink" href="#/intro">${state.lang==='es'?'Inicio':'Intro'}</a></div><div class="track-hero"><div class="track-cover"><img class="cover" src="${esc(t.cover_url)}" alt=""></div><div class="track-copy"><div class="kicker">${String(t.position).padStart(2,'0')}</div><div class="artist">${esc(text(t,'artist'))}</div><h2>${esc(text(t,'title'))}</h2><div class="track-meta">${esc(text(t,'album'))}${t.label?' · '+esc(t.label):''}${t.year?' · '+esc(t.year):''}</div><div class="editorial dropcap">${esc(text(t,'editorial'))}</div>${reactions}<div class="comments">${comments}</div></div></div>${everyTenPromo(t.position)}<nav class="track-nav"><span>${prev?`<a href="${trackUrl(prev.position)}"><span class="arrow">←</span> ${state.lang==='es'?'Previous':'Previous'}</a>`:''}</span><a href="#/grid">Grid</a><a href="#/intro">${state.lang==='es'?'Inicio':'Intro'}</a><span>${next?`<a href="${trackUrl(next.position)}">${state.lang==='es'?'Next':'Next'} <span class="arrow">→</span></a>`:''}</span></nav></section>`;
    bindForms();
  }
  function renderEnd(){
    view.innerHTML=`<section class="end"><div><h1>Gracias</h1><div class="links"><a class="underlink" href="${esc(cfg.LINKTREE_URL)}" target="_blank" rel="noopener">Linktree ↗</a><a class="underlink" href="${esc(cfg.SPOTIFY_PLAYLIST_URL)}" target="_blank" rel="noopener">Spotify playlist ↗</a></div><p><a class="underlink" href="#/grid">${state.lang==='es'?'Volver al Grid':'Back to Grid'}</a></p></div></section>`;
  }
  function renderError(msg){ view.innerHTML=`<section class="admin-login"><div class="notice error">${esc(msg)}</div></section>`; }
  function renderRoute(){
    if(state.loading){view.innerHTML='<section><div class="kicker">Loading</div></section>';return;}
    const parts=location.hash.replace(/^#\/?/,'').split('/'); const route=parts[0]||'intro';
    if(route==='intro') renderIntro(); else if(route==='grid') renderGrid(); else if(route==='track') renderTrack(Number(parts[1])); else if(route==='end') renderEnd(); else renderIntro();
    setTimeout(bindForms,0);
  }
  async function like(target,trackId){
    const {error}=await supabase.from('likes').insert({target_type:target,track_id:trackId||null,client_id:clientId});
    if(error && !String(error.message).includes('duplicate')) console.error(error); renderRoute();
  }
  function bindForms(){
    document.querySelectorAll('[data-like]').forEach(b=>b.onclick=()=>like(b.dataset.like,b.dataset.track||null));
    document.querySelectorAll('[data-comment-form]').forEach(f=>f.onsubmit=async e=>{e.preventDefault();const fd=new FormData(f);const body=String(fd.get('body')||'').trim(),name=String(fd.get('name')||'').trim();if(!body||!name)return;const {error}=await supabase.from('comments').insert({target_type:f.dataset.target,track_id:f.dataset.track||null,name,body,client_id:clientId});if(error)alert(error.message);else f.reset();renderRoute();});
  }
  langBtn.onclick=()=>{state.lang=state.lang==='es'?'en':'es';localStorage.setItem('ls_lang',state.lang);renderRoute();};
  window.addEventListener('hashchange',renderRoute);
  load();
})();
