export const PLAUD_CONNECT_SOURCE = 'nj-plumbing-plaud-connect';
export const PLAUD_WEB_URL = 'https://web.plaud.ai/';
export const PLAUD_WEB_ORIGIN = 'https://web.plaud.ai';

const STORAGE_KEY = 'njPlumbingPlaudConnectToken';

export function isAllowedPlaudConnectOrigin(origin: string): boolean {
  return origin === PLAUD_WEB_ORIGIN || origin === window.location.origin;
}

export function stashPlaudConnectToken(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return;
  sessionStorage.setItem(STORAGE_KEY, trimmed);
}

export function takePlaudConnectTokenFromLocation(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.replace(/^#/, '');
  const hashParams = new URLSearchParams(hash.includes('=') ? hash : '');
  const query = new URLSearchParams(window.location.search);
  const raw = hashParams.get('plaudConnect') || query.get('plaudConnect') || '';
  const token = decodeURIComponent(raw);
  if (token) {
    stashPlaudConnectToken(token);
    const nextQuery = new URLSearchParams(window.location.search);
    nextQuery.delete('plaudConnect');
    const search = nextQuery.toString();
    history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}`
    );
  }
  return sessionStorage.getItem(STORAGE_KEY) || '';
}

export function consumePlaudConnectToken(): string {
  takePlaudConnectTokenFromLocation();
  const token = sessionStorage.getItem(STORAGE_KEY) || '';
  if (token) sessionStorage.removeItem(STORAGE_KEY);
  return token;
}

export function openPlaudConnectWindow(): Window | null {
  return window.open(PLAUD_WEB_URL, 'plaud-connect', 'width=1100,height=800');
}

function plaudConnectBookmarkletSource(appOrigin: string): string {
  return `(function(){
  var app=${JSON.stringify(appOrigin)};
  function jwt(value){
    var match=String(value||'').match(/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/);
    return match?match[0]:'';
  }
  function cookieToken(){
    var map={};
    String(document.cookie||'').split(';').forEach(function(part){
      var i=part.indexOf('=');
      if(i>0) map[part.slice(0,i).trim().toLowerCase()]=part.slice(i+1).trim();
    });
    var names=['pld_wt','pld-wt','pld_ut','pld-ut','pld_token','tokenstr','token'];
    for(var n=0;n<names.length;n++){
      var found=jwt(map[names[n]]||'');
      if(found) return found;
    }
    return jwt(document.cookie);
  }
  function storageToken(store){
    try{
      for(var i=0;i<store.length;i++){
        var key=store.key(i)||'';
        var value=store.getItem(key)||'';
        if(/workspaceList|workspaceToken|token/i.test(key+value)){
          try{
            var parsed=JSON.parse(value);
            var list=Array.isArray(parsed)?parsed:(parsed&&(parsed.list||parsed.data||[parsed]));
            for(var j=0;j<(list||[]).length;j++){
              var item=list[j]||{};
              var found=jwt(item.workspaceToken||item.access_token||item.token||'');
              if(found) return found;
            }
          }catch(e){}
        }
        var direct=jwt(value);
        if(direct) return direct;
      }
    }catch(e){}
    return '';
  }
  function send(token){
    if(!token){
      alert('No Plaud login found. Sign in at web.plaud.ai, then click Send to NJ Plumbing again. If it still fails, click a recording first.');
      return;
    }
    try{
      if(window.opener&&!window.opener.closed){
        window.opener.postMessage({source:${JSON.stringify(PLAUD_CONNECT_SOURCE)},token:token},app);
        window.close();
        return;
      }
    }catch(e){}
    location.href=app+'/#plaudConnect='+encodeURIComponent(token);
  }
  var token=cookieToken()||storageToken(localStorage)||storageToken(sessionStorage);
  if(token){send(token);return;}
  var original=window.fetch;
  window.fetch=function(){
    var headers=arguments[1]&&arguments[1].headers;
    var auth='';
    if(headers&&typeof headers.get==='function') auth=headers.get('Authorization')||'';
    else if(headers) auth=headers.Authorization||headers.authorization||'';
    var found=jwt(String(auth).replace(/^(bearer|wt|ut|wrt)\\s+/i,''));
    if(found){window.fetch=original;send(found);}
    return original.apply(this,arguments);
  };
  alert('Click any recording in Plaud. This will send the login to NJ Plumbing.');
})();`;
}

export function plaudConnectBookmarkletHref(appOrigin = window.location.origin): string {
  return `javascript:${encodeURIComponent(plaudConnectBookmarkletSource(appOrigin))}`;
}
