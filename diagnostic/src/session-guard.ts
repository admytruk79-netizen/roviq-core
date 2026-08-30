const TOKEN='roviq_diagnostic_token';
const PRINCIPAL='roviq_diagnostic_principal';
const nativeFetch=window.fetch.bind(window);

function expired(token:string){
  try{const p=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))) as {exp?:number};return typeof p.exp==='number'&&p.exp*1000<=Date.now()}catch{return false}
}
function clear(){localStorage.removeItem(TOKEN);localStorage.removeItem(PRINCIPAL)}

const stored=localStorage.getItem(TOKEN);
if(stored&&expired(stored))clear();

window.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const hadSession=Boolean(localStorage.getItem(TOKEN));
  const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
  let response:Response;
  try{
    response=await nativeFetch(input,init);
    if(method==='GET'&&[502,503,504].includes(response.status)){
      await new Promise(r=>setTimeout(r,350));
      response=await nativeFetch(input,init);
    }
  }catch(error){
    if(method!=='GET')throw error;
    await new Promise(r=>setTimeout(r,350));
    response=await nativeFetch(input,init);
  }
  if(response.status===401&&hadSession){clear();location.reload()}
  return response;
};

history.replaceState({...history.state,roviqRoot:true},'');
history.pushState({roviqGuard:true},'');
window.addEventListener('popstate',()=>{
  if(localStorage.getItem(TOKEN)){
    history.pushState({roviqGuard:true},'');
    window.dispatchEvent(new Event('roviq:back'));
  }
});
