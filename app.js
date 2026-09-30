(() => {
  const cfg = window.APP_CONFIG || {};
  const view = document.getElementById('view');
  const countEl = document.getElementById('listener-count');
  const langBtn = document.getElementById('lang-toggle');
  const supabase = window.supabase?.createClient(cfg.SUPABASE_URL || '', cfg.SUPABASE_ANON_KEY || '');
  const sessionSlug = cfg.SESSION_SLUG || 'main';
  let state = { session:null, tracks:[], lang: getLang(), loading:true, counts:{}, liked:{} };
  let presenceChannel = null;
  let realtimeChannel = null;
  let sessionPollTimer = null;
  let countdownTimer = null;
  let renderSeq = 0;
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
    return `<div class="intro-next"><button class="next-main ${started?'is-started':''}" data-intro-next>${label}</button><div class="intro-choice" data-intro-choice hidden><div class="intro-choice-title">${state.lang==='es'?'¿Dónde quieres ir?':'Where would you like to go?'}</div><div class="intro-choice-actions"><a class="choice-button" href="#/grid">${state.lang==='es'?'Grid':'Grid'}</a><a class="choice-button current-choice" data-current-track href="${trackUrl(getCurrent())}">${state.lang==='es'?'Tema actual':'Current track'}</a></div></div></div>`;
  }
  async function load(){
    if(!supabase){ renderError('Configura config.js antes de usar la web.'); return; }
    const {data:session,error:sErr}=await supabase.from('session_state').select('*').eq('slug',sessionSlug).single();
    if(sErr){ renderError(sErr.message); return; }
    state.session=session;
    await refreshTracks();
    state.loading=false;
    await loadReactionCounts();
    subscribeRealtime(); subscribePresence(); startSessionPolling(); renderRoute();
  }
  async function refreshTracks(){
    const {data:tracks,error}=await supabase.from('tracks').select('*').order('position');
    if(error){ console.error('Track refresh error:', error); return false; }
    state.tracks=tracks||[];
    return true;
  }
  function startSessionPolling(){
    if(sessionPollTimer) clearInterval(sessionPollTimer);
    sessionPollTimer=setInterval(async()=>{
      if(document.visibilityState==='hidden') return;
      const {data:session,error}=await supabase.from('session_state').select('*').eq('slug',sessionSlug).single();
      if(error || !session) return;
      const changed=!state.session || session.current_position!==state.session.current_position || session.status!==state.session.status || session.countdown_enabled!==state.session.countdown_enabled || session.countdown_target_at!==state.session.countdown_target_at;
      if(changed){ state.session=session; await refreshTracks(); await loadReactionCounts(); renderRoute(); }
    },1000);
  }
  async function loadReactionCounts(){
    const trackIds=state.tracks.map(t=>t.id);
    const counts={};
    const liked={};
    const {data:trackLikes}=trackIds.length
      ? await supabase.from('likes').select('id,track_id,client_id').eq('target_type','track').in('track_id',trackIds)
      : {data:[]};
    (trackLikes||[]).forEach(x=>{
      counts[x.track_id]=(counts[x.track_id]||0)+1;
      if(x.client_id===clientId) liked[`track:${x.track_id}`]=true;
    });
    const {data:introLikes}=await supabase.from('likes').select('id,client_id').eq('target_type','intro');
    if(introLikes?.some(x=>x.client_id===clientId)) liked['intro:']=true;
    state.counts.likes=counts;
    state.counts.intro=(introLikes||[]).length;
    state.liked=liked;
  }
  function subscribeRealtime(){
    if(realtimeChannel) supabase.removeChannel(realtimeChannel);
    realtimeChannel=supabase.channel(`session-${sessionSlug}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'session_state',filter:`slug=eq.${sessionSlug}`},async p=>{
        state.session=p.new;
        await refreshTracks();
        await loadReactionCounts();
        renderRoute();
      })
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
  function reactionsHtml(targetType,trackId){
    const key=`${targetType}:${trackId||''}`;
    const count=targetType==='intro' ? (state.counts.intro||0) : (state.counts.likes?.[trackId]||0);
    const liked=!!state.liked[key];
    const label=state.lang==='es' ? (liked?'Me gusta':'Me gusta') : 'Like';
    return `<div class="reaction-row"><button class="like-button ${liked?'is-liked':''}" data-like="${targetType}" data-track="${trackId||''}" aria-pressed="${liked}">${liked?'♥':'♡'} ${count} <span class="like-label">${label}</span></button></div>`;
  }
  async function commentsHtml(targetType,trackId){
    const cs=await commentsFor(targetType,trackId);
    return `<div class="comments"><div class="comment-list">${cs.map(c=>`<div class="comment"><strong>${esc(c.name)}</strong>${esc(c.body)}</div>`).join('')}</div><form class="comment-form" data-comment-form data-target="${targetType}" data-track="${trackId||''}"><input name="name" maxlength="60" required placeholder="${state.lang==='es'?'Nombre':'Name'}"><textarea name="body" maxlength="500" required placeholder="${state.lang==='es'?'Comentario':'Comment'}"></textarea><button class="submit" type="submit">${state.lang==='es'?'Enviar':'Send'}</button></form></div>`;
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
  async function renderIntro(renderId){
    const intro=state.session||{};
    const comments=await commentsHtml('intro',null); const reactions=await reactionsHtml('intro',null);
    if(renderId !== renderSeq) return;
    view.innerHTML=`<section class="intro"><div class="intro-grid"><div class="hero-cover">${intro.intro_cover_url?`<img class="cover" src="${esc(intro.intro_cover_url)}" alt="">`:''}</div><div><div class="kicker">${state.lang==='es'?'Sesión de escucha':'Listening session'}</div><h1>${esc(text(intro,'intro_title')||intro.title||'Listening Session')}</h1><div class="intro-copy dropcap">${esc(text(intro,'intro_text'))}</div>${countdownHtml()}${introNextHtml()}${promoHtml()}<div class="reactions">${reactions}${comments}</div></div></div></section>`;
    startCountdown();
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
  async function renderTrack(position,renderId){
    const t=state.tracks.find(x=>x.position===position);
    if(!t || !isVisible(t)){ location.hash='#/grid'; return; }
    const ended=state.session?.status==='finished';
    const prev=state.tracks.find(x=>x.position===position-1 && isVisible(x)); const next=state.tracks.find(x=>x.position===position+1 && isVisible(x));
    const comments=await commentsHtml('track',t.id); const reactions=await reactionsHtml('track',t.id);
    if(renderId !== renderSeq) return;
    view.innerHTML=`<section class="track-page"><div class="track-topnav"><a class="underlink" href="#/grid">Grid</a><a class="underlink" href="#/intro">${state.lang==='es'?'Inicio':'Intro'}</a></div><div class="track-hero"><div class="track-cover"><img class="cover" src="${esc(t.cover_url)}" alt=""></div><div class="track-copy"><div class="kicker">${String(t.position).padStart(2,'0')}</div><div class="artist">${esc(text(t,'artist'))}</div><h2>${esc(text(t,'title'))}</h2><div class="track-meta">${esc(text(t,'album'))}${t.label?' · '+esc(t.label):''}${t.year?' · '+esc(t.year):''}</div><div class="editorial dropcap">${esc(text(t,'editorial'))}</div>${reactions}<div class="comments">${comments}</div></div></div>${everyTenPromo(t.position)}<nav class="track-nav"><span>${prev?`<a href="${trackUrl(prev.position)}"><span class="arrow">←</span> ${state.lang==='es'?'Anterior':'Previous'}</a>`:''}</span><a href="#/grid">Grid</a><a href="#/intro">${state.lang==='es'?'Inicio':'Home'}</a><a href="${currentTrack()?trackUrl(currentTrack().position):'#'}" class="current-link">${state.lang==='es'?'Actual':'Current'}</a><span>${next?`<a href="${trackUrl(next.position)}">${state.lang==='es'?'Siguiente':'Next'} <span class="arrow">→</span></a>`:''}</span></nav></section>`;
    bindForms();
  }
  function renderEnd(){
    view.innerHTML=`<section class="end"><div><h1>Gracias</h1><div class="links"><a class="underlink" href="${esc(cfg.LINKTREE_URL)}" target="_blank" rel="noopener">Linktree ↗</a><a class="underlink" href="${esc(cfg.SPOTIFY_PLAYLIST_URL)}" target="_blank" rel="noopener">Spotify playlist ↗</a></div><p><a class="underlink" href="#/grid">${state.lang==='es'?'Volver al Grid':'Back to Grid'}</a></p></div></section>`;
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
          client_id:clientId
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
  load();
})();
