const legacyMessages=new Set([
  'Refresh Asun IMG to authorize image generation.',
  'Refresh Asun IMG to authorize sheet generation.',
  'Refresh Asun IMG to authorize the generation queue.',
]);

// These errors are local pre-admission checks, not provider authorization errors.
export function isLocalGenerationAuthError(error) {
  return error?.status===403&&(error.code==='ASUN_LOCAL_TOKEN_EXPIRED'||legacyMessages.has(error.message));
}

export async function isLocalGenerationAuthResponse(response) {
  if(response?.status!==403)return false;
  try{const data=await response.clone().json();return isLocalGenerationAuthError({status:response.status,code:data?.code,message:data?.error||data?.message});}catch{return false;}
}
