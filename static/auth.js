const TKEY="pelu_token", RKEY="pelu_rol", UKEY="pelu_user";
function getToken(){return localStorage.getItem(TKEY);}
function getRol(){return localStorage.getItem(RKEY);}
function getUser(){return localStorage.getItem(UKEY);}
function logout(){localStorage.removeItem(TKEY);localStorage.removeItem(RKEY);localStorage.removeItem(UKEY);location.href="/login";}
async function authFetch(url,opts){
  opts=opts||{};
  opts.headers=Object.assign({},opts.headers||{},{"Authorization":"Bearer "+getToken()});
  const r=await fetch(url,opts);
  if(r.status===401){logout();throw new Error("sesion vencida");}
  return r;
}
function requireLogin(){ if(!getToken()){location.href="/login";} }
function requireDueno(){ requireLogin(); if(getRol()!=="dueno"){location.href="/";} }
function pintarNav(){ if(getRol()!=="dueno"){document.querySelectorAll('[data-rol="dueno"]').forEach(e=>e.style.display="none");} }
