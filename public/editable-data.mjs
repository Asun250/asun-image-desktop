// Detach editable state while sharing immutable string values (in particular
// original image data URLs). structuredClone materializes those large strings
// again for every edit and Undo snapshot. Arrays/objects must never be shared.
export function cloneEditableData(value,seen=new Map()) {
  if(typeof value==='function'||typeof value==='symbol')throw new DOMException('This value cannot be saved.','DataCloneError');
  if(value===null||typeof value!=='object')return value;
  if(seen.has(value))return seen.get(value);
  if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)return structuredClone(value);
  const result=Array.isArray(value)?new Array(value.length):{};seen.set(value,result);
  for(const key of Object.keys(value))Object.defineProperty(result,key,{value:cloneEditableData(value[key],seen),enumerable:true,writable:true,configurable:true});
  return result;
}

// Compare state directly, without allocating two JSON strings containing every
// original image. Only plain serialized data is considered structurally equal.
export function sameEditableData(a,b,seen=new WeakMap()) {
  if(Object.is(a,b))return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const plain=value=>Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null;
  if(!plain(a)||!plain(b))return false;
  if(Array.isArray(a)&&a.length!==b.length)return false;
  if(seen.get(a)===b)return true;seen.set(a,b);
  const keys=Object.keys(a);if(keys.length!==Object.keys(b).length)return false;
  return keys.every(key=>Object.hasOwn(b,key)&&sameEditableData(a[key],b[key],seen));
}
