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
function pintarNav(){
  const nav=document.querySelector("nav.menu");
  if(!nav) return;
  const rol=getRol();
  const aqui=location.pathname;
  // Un solo lugar donde se definen los links del menú. Cambiás acá y se actualiza en todas las páginas.
  const links=[
    {href:"/",           txt:"Facturar"},
    {href:"/clientes",   txt:"Clientes"},
    {href:"/historial",  txt:"Historial"},
    {href:"/agenda",     txt:"Agenda"},
    {href:"/caja",       txt:"Caja"},
    {href:"/inventario", txt:"Inventario", dueno:true},
    {href:"/reportes",   txt:"Reportes",   dueno:true},
    {href:"/admin",      txt:"Admin",      dueno:true},
  ];
  let html="";
  for(const l of links){
    if(l.dueno && rol!=="dueno") continue;   // los empleados no ven los links de dueño
    const esActual = (l.href===aqui) || (l.href==="/" && aqui==="/facturar");
    html+=`<a href="${l.href}"${esActual?' class="actual"':''}>${l.txt}</a>`;
  }
  html+=`<a href="#" onclick="logout();return false;">Salir</a>`;
  nav.innerHTML=html;
}

function titulo(str){
  return (str||"").toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase());
}