(() => {
  const cfg = window.APP_CONFIG || {};
  const view = document.getElementById('view');
  const countEl = document.getElementById('listener-count');
  const langBtn = document.getElementById('lang-toggle');
  const supabase = window.supabase?.createClient(cfg.SUPABASE_URL || '', cfg.SUPABASE_ANON_KEY || '');
  const fallbackSessionSlug = cfg.SESSION_SLUG || 'presentation';
  let state = { session:null, tracks:[], lang: getLang(), loading:true, counts:{}, liked:{} };
  let presenceChannel = null;
  let realtimeChannel = null;
  let sessionPollTimer = null;
  let countdownTimer = null;
  let renderSeq = 0;
  let previousSessionPosition = null;
  let sessionInitialized = false;
  let promptTimer = null;
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
  function iconSvg(name){
    const paths={
      home:'<path d="M3.5 10.5 12 3l8.5 7.5"></path><path d="M5.5 9.5V20h13V9.5"></path><path d="M9.5 20v-6h5v6"></path>',
      grid:'<rect x="4" y="4" width="6" height="6"></rect><rect x="14" y="4" width="6" height="6"></rect><rect x="4" y="14" width="6" height="6"></rect><rect x="14" y="14" width="6" height="6"></rect>',
      prev:'<path d="M19 12H5"></path><path d="m11 6-6 6 6 6"></path>',
      next:'<path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path>',
      current:'<circle cx="12" cy="12" r="7.5"></circle><circle cx="12" cy="12" r="2"></circle>',
      music:'<path d="M9 17.5V5l10-2v12.5"></path><circle cx="6.5" cy="17.5" r="2.5"></circle><circle cx="16.5" cy="15.5" r="2.5"></circle>',
      link:'<path d="M9.5 14.5 14.5 9.5"></path><path d="M7.2 17.8 5.5 19.5a3.2 3.2 0 0 1-4.5-4.5l3.8-3.8a3.2 3.2 0 0 1 4.5 0"></path><path d="M16.8 6.2 18.5 4.5a3.2 3.2 0 1 1 4.5 4.5l-3.8 3.8a3.2 3.2 0 0 1-4.5 0"></path>'
    };
    return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||''}</svg>`;
  }
  function promoHtml(){
    return `<div class="promo"><small>${state.lang==='es'?'Enlaces':'Links'}</small><div class="links"><a class="underlink icon-link" href="${esc(cfg.SPOTIFY_PLAYLIST_URL)}" target="_blank" rel="noopener"><span class="link-icon">${iconSvg('music')}</span><span>Spotify playlist ↗</span></a><a class="underlink icon-link" href="${esc(cfg.LINKTREE_URL)}" target="_blank" rel="noopener"><span class="link-icon">${iconSvg('link')}</span><span>Linktree ↗</span></a></div></div>`;
  }
  function everyTenPromo(position){ return position % 10 === 0 ? promoHtml() : ''; }
  function currentTrack(){
    const pos=getCurrent();
    return pos ? state.tracks.find(t=>t.position===pos) : null;
  }
  function introNextHtml(){
    const started=state.session?.status==='live' && getCurrent()>0;
    const label=state.lang==='es'?'Siguiente':'Continue';
    const message=state.lang==='es'?'La sesión aún no ha comenzado.':'The session has not started yet.';
    if(!started){
      return `<div class="intro-next"><button class="next-main ${started?'is-started':''}" data-intro-next>${label}</button><div class="intro-next-message" data-intro-message hidden>${message}</div></div>`;
    }
    return `<div class="intro-next"><button class="next-main ${started?'is-started':''}" data-intro-next>${label}</button><div class="intro-choice" data-intro-choice hidden><div class="intro-choice-title">${state.lang==='es'?'¿Dónde quieres ir?':'Where would you like to go?'}</div><div class="intro-choice-actions"><a class="choice-button" href="#/grid">${iconSvg('grid')}<span>${state.lang==='es'?'Grid':'Grid'}</span></a><a class="choice-button" data-current-track href="${trackUrl(getCurrent())}">${iconSvg('current')}<span>${state.lang==='es'?'Tema actual':'Current track'}</span></a></div></div></div>`;
  }
  async function load(){
    if(!supabase){ renderError('Configura config.js antes de usar la web.'); return; }
    const {data:session,error:sErr}=await supabase.from('session_state').select('*').eq('is_active',true).single();
    if(sErr || !session){ const fallback=await supabase.from('session_state').select('*').eq('slug',fallbackSessionSlug).single(); if(fallback.error){ renderError((sErr||fallback.error).message); return; } state.session=fallback.data; } else state.session=session;
    previousSessionPosition=state.session.status==='finished' ? 0 : (state.session.current_position||0);
    sessionInitialized=true;
    await refreshTracks();
    state.loading=false;
    await loadReactionCounts();
    subscribeRealtime(); subscribePresence(); startSessionPolling(); renderRoute();
  }
  async function refreshTracks(){
    const {data:tracks,error}=await supabase.from('tracks').select('*').eq('session_slug',state.session?.slug||fallbackSessionSlug).order('position');
    if(error){ console.error('Track refresh error:', error); return false; }
    state.tracks=tracks||[];
    return true;
  }
  function startSessionPolling(){
    if(sessionPollTimer) clearInterval(sessionPollTimer);
    sessionPollTimer=setInterval(async()=>{
      if(document.visibilityState==='hidden') return;
      const {data:session,error}=await supabase.from('session_state').select('*').eq('is_active',true).single();
      if(error || !session) return;
      const changed=!state.session || session.slug!==state.session.slug || session.current_position!==state.session.current_position || session.status!==state.session.status || session.countdown_enabled!==state.session.countdown_enabled || session.countdown_target_at!==state.session.countdown_target_at;
      if(changed){
        const oldPosition=previousSessionPosition;
        const oldSlug=state.session?.slug;
        const newPosition=session.status==='finished' ? 0 : (session.current_position||0);
        state.session=session;
        previousSessionPosition=newPosition;
        if(oldSlug!==session.slug) subscribePresence();
        await refreshTracks(); await loadReactionCounts(); await renderRoute();
        maybePromptForSessionChange(oldPosition,newPosition);
      }
    },1000);
  }
  async function loadReactionCounts(){
    const trackIds=state.tracks.map(t=>t.id);
    const counts={};
    const liked={};
    const {data:trackLikes}=trackIds.length
      ? await supabase.from('likes').select('id,track_id,client_id').eq('target_type','track').eq('session_slug',state.session?.slug||fallbackSessionSlug).in('track_id',trackIds)
      : {data:[]};
    (trackLikes||[]).forEach(x=>{
      counts[x.track_id]=(counts[x.track_id]||0)+1;
      if(x.client_id===clientId) liked[`track:${x.track_id}`]=true;
    });
    const {data:introLikes}=await supabase.from('likes').select('id,client_id').eq('target_type','intro').eq('session_slug',state.session?.slug||fallbackSessionSlug);
    const {data:comments}=trackIds.length
      ? await supabase.from('comments').select('id,track_id').eq('target_type','track').eq('session_slug',state.session?.slug||fallbackSessionSlug).in('track_id',trackIds)
      : {data:[]};
    const commentCounts={};
    (comments||[]).forEach(x=>{ commentCounts[x.track_id]=(commentCounts[x.track_id]||0)+1; });
    if(introLikes?.some(x=>x.client_id===clientId)) liked['intro:']=true;
    state.counts.likes=counts;
    state.counts.comments=commentCounts;
    state.counts.intro=(introLikes||[]).length;
    state.liked=liked;
  }
  function subscribeRealtime(){
    if(realtimeChannel) supabase.removeChannel(realtimeChannel);
    realtimeChannel=supabase.channel('session-live-updates')
      .on('postgres_changes',{event:'*',schema:'public',table:'session_state'},async ()=>{
        const oldPosition=previousSessionPosition;
        const {data:active}=await supabase.from('session_state').select('*').eq('is_active',true).single();
        if(!active) return;
        const newPosition=active.status==='finished' ? 0 : (active.current_position||0);
        const changed=!state.session || active.slug!==state.session.slug || active.current_position!==state.session.current_position || active.status!==state.session.status;
        if(!changed) return;
        const oldSlug=state.session?.slug;
        state.session=active;
        previousSessionPosition=newPosition;
        if(oldSlug!==active.slug) subscribePresence();
        await refreshTracks();
        await loadReactionCounts();
        await renderRoute();
        if(sessionInitialized) maybePromptForSessionChange(oldPosition,newPosition);
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'comments'},()=>renderRoute())
      .on('postgres_changes',{event:'*',schema:'public',table:'likes'},()=>renderRoute())
      .subscribe();
  }
  function subscribePresence(){
    if(presenceChannel) supabase.removeChannel(presenceChannel);
    presenceChannel=supabase.channel(`listeners-${state.session?.slug||fallbackSessionSlug}`,{config:{presence:{key:clientId}}});
    presenceChannel.on('presence',{event:'sync'},()=>updatePresenceCount()).subscribe(async status=>{ if(status==='SUBSCRIBED'){ await presenceChannel.track({online_at:new Date().toISOString()}); updatePresenceCount(); }});
  }
  function updatePresenceCount(){
    const statePresence=presenceChannel?.presenceState?.()||{}; const n=Object.keys(statePresence).length; countEl.textContent=formatListeners(n); }
  async function commentsFor(targetType,trackId){
    let q=supabase.from('comments').select('*').eq('target_type',targetType).order('created_at',{ascending:true}).limit(50);
    q=q.eq('session_slug',state.session?.slug||fallbackSessionSlug);
    q=trackId ? q.eq('track_id',trackId) : q.is('track_id',null);
    const {data}=await q; return data||[];
  }
  function reactionsHtml(targetType,trackId){
    const key=`${targetType}:${trackId||''}`;
    const count=targetType==='intro' ? (state.counts.intro||0) : (state.counts.likes?.[trackId]||0);
    const liked=!!state.liked[key];
    const label=state.lang==='es' ? (liked?'Me gusta':'Me gusta') : 'Like';
    return `<div class="reaction-row"><button class="like-button ${liked?'is-liked':''}" data-like="${targetType}" data-track="${trackId||''}" aria-pressed="${liked}">${liked?'♥':'♡'} ${count} <span class="like-label">${label}</span></button></div>`;
  }
  async function commentsHtml(targetType,trackId){
    const cs=await commentsFor(targetType,trackId);
    return `<div class="comments"><div class="comment-list">${cs.map(c=>`<div class="comment"><strong>${esc(c.name)}</strong><span class="comment-body">${esc(c.body)}</span></div>`).join('')}</div><form class="comment-form" data-comment-form data-target="${targetType}" data-track="${trackId||''}"><input name="name" maxlength="60" required placeholder="${state.lang==='es'?'Nombre':'Name'}"><textarea name="body" maxlength="500" required placeholder="${state.lang==='es'?'Comentario':'Comment'}"></textarea><button class="submit" type="submit">${state.lang==='es'?'Enviar':'Send'}</button></form></div>`;
  }
  function countdownHtml(){
    if(!state.session?.countdown_enabled || !state.session?.countdown_target_at) return '';
    const label=state.lang==='es'?'La sesión comienza en':'Session starts in';
    return `<div class="countdown" data-countdown-target="${esc(state.session.countdown_target_at)}"><div class="countdown-label">${label}</div><div class="countdown-time"><span data-cd-days>00</span><i>:</i><span data-cd-hours>00</span><i>:</i><span data-cd-minutes>00</span><i>:</i><span data-cd-seconds>00</span></div></div>`;
  }
  function startCountdown(){
    if(countdownTimer) clearInterval(countdownTimer);
    const el=document.querySelector('[data-countdown-target]');
    if(!el) return;
    const target=new Date(el.dataset.countdownTarget).getTime();
    const tick=()=>{
      const diff=Math.max(0,target-Date.now());
      const total=Math.floor(diff/1000);
      const days=Math.floor(total/86400); const hours=Math.floor((total%86400)/3600); const minutes=Math.floor((total%3600)/60); const seconds=total%60;
      const set=(sel,v)=>{const n=el.querySelector(sel);if(n)n.textContent=String(v).padStart(2,'0');};
      set('[data-cd-days]',days); set('[data-cd-hours]',hours); set('[data-cd-minutes]',minutes); set('[data-cd-seconds]',seconds);
      if(diff<=0) clearInterval(countdownTimer);
    };
    tick(); countdownTimer=setInterval(tick,1000);
  }
  function fitIntroText(){
    const el=document.querySelector('.intro-copy');
    if(!el) return;
    const minSize=window.innerWidth<=430 ? 20 : (window.innerWidth<=800 ? 22 : 24);
    let size=26;
    el.style.fontSize=size+'px';
    // First make sure the copy never creates horizontal overflow.
    while(el.scrollWidth > el.clientWidth + 1 && size>minSize){
      size-=1;
      el.style.fontSize=size+'px';
    }
    // On compact screens, gently reduce the copy if the opening composition becomes too tall.
    const available=Math.max(300, window.innerHeight - (window.innerWidth<=800 ? 250 : 190));
    while(el.scrollHeight > available && size>minSize){
      size-=1;
      el.style.fontSize=size+'px';
    }
  }
  async function renderIntro(renderId){
    const intro=state.session||{};
    const comments=await commentsHtml('intro',null); const reactions=await reactionsHtml('intro',null);
    if(renderId !== renderSeq) return;
    view.innerHTML=`<section class="intro"><div class="intro-grid"><div class="hero-cover">${intro.intro_cover_url?`<img class="cover" src="${esc(intro.intro_cover_url)}" alt="">`:''}</div><div><div class="kicker">${state.lang==='es'?'Sesión de escucha':'Listening session'}</div><h1>${esc(text(intro,'intro_title')||intro.title||'Listening Session')}</h1><div class="intro-copy dropcap">${esc(text(intro,'intro_text'))}</div>${countdownHtml()}${introNextHtml()}${promoHtml()}<div class="reactions">${reactions}${comments}</div></div></div></section>`;
    startCountdown();
    requestAnimationFrame(fitIntroText);
  }
  function gridReactionHtml(t){
    const likes=state.counts.likes?.[t.id]||0;
    const comments=state.counts.comments?.[t.id]||0;
    return `<div class="tile-reactions"><span>♥ ${likes}</span><span>◌ ${comments}</span></div>`;
  }
  function renderGrid(){
    const ended=state.session?.status==='finished';
    const coverTile=`<div class="track-tile intro-tile"><a href="#/intro"><div class="tile-cover intro-tile-cover"><img class="cover" src="${esc(state.session?.intro_cover_url||'')}" alt=""></div><div class="tile-overlay"><span class="tile-number">INTRO</span><div class="tile-info">${esc(text(state.session||{},'intro_title')||state.session?.title||'Listening session')}</div></div></a></div>`;
    const tiles=state.tracks.map(t=>{
      const unlocked=isVisible(t); const current=!ended && t.position===getCurrent();
      if(!unlocked) return `<div class="track-tile locked"><span class="tile-number">${String(t.position).padStart(2,'0')}</span></div>`;
      return `<div class="track-tile ${current?'is-current':''}"><a href="${trackUrl(t.position)}"><div class="tile-cover"><img src="${esc(t.cover_url)}" alt=""></div><div class="tile-overlay"><span class="tile-number">${String(t.position).padStart(2,'0')}</span>${current?'<span class="now-playing"><i></i><i></i><i></i><i></i></span>':''}<div class="tile-info">${esc(text(t,'artist'))}<small>${esc(text(t,'title'))}</small></div>${gridReactionHtml(t)}</div></a></div>`;
    }).join('');
    view.innerHTML=`<section><div class="grid-head"><div><div class="kicker">${ended?(state.lang==='es'?'Sesión terminada':'Session ended'):(state.lang==='es'?'Tracklist':'Tracklist')}</div><h2>Grid</h2></div><a class="icon-link" href="#/intro">${iconSvg('home')}<span>${state.lang==='es'?'Inicio':'Intro'}</span></a></div><div class="track-grid">${coverTile}${tiles}</div>${promoHtml()}</section>`;
  }
  async function renderTrack(position,renderId){
    const t=state.tracks.find(x=>x.position===position);
    if(!t || !isVisible(t)){ location.hash='#/grid'; return; }
    const ended=state.session?.status==='finished';
    const prev=state.tracks.find(x=>x.position===position-1 && isVisible(x)); const next=state.tracks.find(x=>x.position===position+1 && isVisible(x));
    const comments=await commentsHtml('track',t.id); const reactions=await reactionsHtml('track',t.id);
    if(renderId !== renderSeq) return;
    view.innerHTML=`<section class="track-page"><div class="track-topnav"><a class="underlink" href="#/grid">Grid</a><a class="underlink" href="#/intro">${state.lang==='es'?'Inicio':'Intro'}</a></div><div class="track-hero"><div class="track-cover"><img class="cover" src="${esc(t.cover_url)}" alt=""></div><div class="track-copy"><div class="kicker">${String(t.position).padStart(2,'0')}</div><div class="track-field artist-field"><span class="track-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2"></circle><path d="M5.5 20c.8-3.5 3-5.2 6.5-5.2s5.7 1.7 6.5 5.2"></path></svg></span><div class="artist">${esc(text(t,'artist'))}</div></div><div class="track-field title-field"><span class="track-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 17.5V5l10-2v12.5"></path><circle cx="6.5" cy="17.5" r="2.5"></circle><circle cx="16.5" cy="15.5" r="2.5"></circle></svg></span><h2>${esc(text(t,'title'))}</h2></div><div class="track-details"><div class="track-field album-field"><span class="track-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><circle cx="12" cy="12" r="2.1"></circle><circle cx="12" cy="12" r="5.2"></circle></svg></span><span>${esc(text(t,'album'))}</span></div>${t.label?`<div class="track-field label-field"><span class="track-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3.5 7.5V4h3.5l13.5 13.5-3.5 3.5L3.5 7.5Z"></path><circle cx="7" cy="7" r="1.2"></circle></svg></span><span>${esc(t.label)}${t.year?' · '+esc(t.year):''}</span></div>`:t.year?`<div class="track-field label-field"><span class="track-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"></path><path d="M8 8h8M8 12h8M8 16h5"></path></svg></span><span>${esc(t.year)}</span></div>`:''}</div><div class="editorial dropcap">${esc(text(t,'editorial'))}</div>${reactions}<div class="comments">${comments}</div></div></div>${everyTenPromo(t.position)}<nav class="track-nav"><a class="nav-button ${prev?'':'is-disabled'}" ${prev?`href="${trackUrl(prev.position)}"`:''}>${iconSvg('prev')}<span>${state.lang==='es'?'Anterior':'Previous'}</span></a><a class="nav-button" href="#/intro">${iconSvg('home')}<span>${state.lang==='es'?'Inicio':'Home'}</span></a><a class="nav-button" href="#/grid">${iconSvg('grid')}<span>Grid</span></a><a class="nav-button ${currentTrack()?'':'is-disabled'}" ${currentTrack()?`href="${trackUrl(currentTrack().position)}"`:''}>${iconSvg('current')}<span>${state.lang==='es'?'Actual':'Current'}</span></a><a class="nav-button ${next?'':'is-disabled'}" ${next?`href="${trackUrl(next.position)}"`:''}>${iconSvg('next')}<span>${state.lang==='es'?'Siguiente':'Next'}</span></a></nav></section>`;
    bindForms();
  }
  function renderEnd(){
    view.innerHTML=`<section class="end"><div><h1>Gracias</h1><div class="links"><a class="underlink icon-link" href="${esc(cfg.LINKTREE_URL)}" target="_blank" rel="noopener"><span class="link-icon">${iconSvg('link')}</span><span>Linktree ↗</span></a><a class="underlink icon-link" href="${esc(cfg.SPOTIFY_PLAYLIST_URL)}" target="_blank" rel="noopener"><span class="link-icon">${iconSvg('music')}</span><span>Spotify playlist ↗</span></a></div><p><a class="underlink" href="#/grid">${state.lang==='es'?'Volver al Grid':'Back to Grid'}</a></p></div></section>`;
  }
  function renderError(msg){ view.innerHTML=`<section class="admin-login"><div class="notice error">${esc(msg)}</div></section>`; }
  async function renderRoute(){
    const renderId = ++renderSeq;
    if(state.loading){view.innerHTML='<section><div class="kicker">Loading</div></section>';return;}
    const parts=location.hash.replace(/^#\/?/,'').split('/'); const route=parts[0]||'intro';
    if(route==='intro') await renderIntro(renderId);
    else if(route==='grid') renderGrid();
    else if(route==='track') await renderTrack(Number(parts[1]),renderId);
    else if(route==='end') renderEnd();
    else await renderIntro(renderId);
    if(renderId === renderSeq) bindForms();
  }

  async function like(target,trackId){
    const key=`${target}:${trackId||''}`;
    const liked=!!state.liked[key];
    const {error}=await supabase.rpc('toggle_my_like',{
      p_target_type:target,
      p_track_id:trackId||null,
      p_client_id:clientId,
      p_like:!liked
    });
    if(error){
      console.error('Like error:', error);
      alert(state.lang==='es' ? `No se ha podido registrar el like: ${error.message}` : `The like could not be saved: ${error.message}`);
      return;
    }
    await loadReactionCounts();
    await renderRoute();
  }

  function maybePromptForSessionChange(oldPosition,newPosition){
    if(!sessionInitialized || !state.session || state.session.status!=='live') return;
    if(!newPosition || newPosition===oldPosition) return;
    showSessionChangePrompt(newPosition);
  }
  function showSessionChangePrompt(position){
    const track=state.tracks.find(t=>t.position===position);
    if(!track) return;
    const existing=document.querySelector('.session-change-prompt');
    if(existing) existing.remove();
    const el=document.createElement('div');
    el.className='session-change-prompt';
    el.innerHTML=`<div class="session-change-card"><div class="session-change-kicker">${state.lang==='es'?'La sesión continúa':'The session continues'}</div><div class="session-change-title">${state.lang==='es'?'Ahora suena':'Now playing'}: <strong>${esc(text(track,'artist'))} — ${esc(text(track,'title'))}</strong></div><div class="session-change-question">${state.lang==='es'?'¿Quieres ir a la canción actual o quedarte donde estás?':'Would you like to go to the current track or stay where you are?'}</div><div class="session-change-actions"><button data-stay>${state.lang==='es'?'Quedarme aquí':'Stay here'}</button><a href="${trackUrl(position)}" data-go-current>${state.lang==='es'?'Ir a canción actual':'Go to current track'}</a></div></div>`;
    document.body.appendChild(el);
    el.querySelector('[data-stay]').onclick=()=>el.remove();
    el.querySelector('[data-go-current]').onclick=()=>{ el.remove(); setTimeout(()=>window.scrollTo({top:0,left:0,behavior:'auto'}),40); };
    clearTimeout(promptTimer);
    promptTimer=setTimeout(()=>el.remove(),30000);
  }
  function bindForms(){
    document.querySelectorAll('[data-current-track]').forEach(a=>{ a.onclick=()=>{ setTimeout(()=>window.scrollTo({top:0,left:0,behavior:'auto'}),50); }; });
    document.querySelectorAll('[data-intro-next]').forEach(b=>{
      b.onclick=()=>{
        const started=state.session?.status==='live' && getCurrent()>0;
        const message=document.querySelector('[data-intro-message]');
        const choice=document.querySelector('[data-intro-choice]');
        if(!started){
          if(message) message.hidden=false;
          return;
        }
        if(choice) choice.hidden=!choice.hidden;
      };
    });
    document.querySelectorAll('[data-like]').forEach(b=>{
      b.onclick=async ()=>{
        if(b.dataset.busy==='1') return;
        b.dataset.busy='1';
        b.disabled=true;
        try { await like(b.dataset.like,b.dataset.track||null); } finally { b.dataset.busy='0'; }
      };
    });
    document.querySelectorAll('[data-comment-form]').forEach(f=>{
      f.onsubmit=async e=>{
        e.preventDefault();
        if(f.dataset.busy==='1') return;
        const fd=new FormData(f);
        const body=String(fd.get('body')||'').trim();
        const name=String(fd.get('name')||'').trim();
        if(!name||!body) return;
        f.dataset.busy='1';
        const submit=f.querySelector('button[type="submit"]');
        if(submit) submit.disabled=true;
        const {error}=await supabase.from('comments').insert({
          target_type:f.dataset.target,
          track_id:f.dataset.track||null,
          name,
          body,
          client_id:clientId,
          session_slug:state.session?.slug||fallbackSessionSlug
        });
        if(error){
          console.error('Comment error:', error);
          alert(state.lang==='es' ? `No se ha podido enviar el comentario: ${error.message}` : `The comment could not be sent: ${error.message}`);
          f.dataset.busy='0';
          if(submit) submit.disabled=false;
          return;
        }
        f.reset();
        await renderRoute();
      };
    });
  }

  langBtn.onclick=()=>{state.lang=state.lang==='es'?'en':'es';localStorage.setItem('ls_lang',state.lang);renderRoute();};
  window.addEventListener('hashchange',async()=>{ await renderRoute(); window.scrollTo({top:0,left:0,behavior:'auto'}); });
  window.addEventListener('resize',()=>{ if(location.hash==='#/intro' || !location.hash) fitIntroText(); });
  load();
})();
