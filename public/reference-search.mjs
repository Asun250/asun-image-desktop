// User text always remains a query on Google Images, including URL-looking text.
export function referenceSearchUrl(query = '') {
  let text = typeof query === 'string' ? query.trim().toWellFormed().slice(0,200) : '';
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0,-1);
  return text ? `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(text)}` : 'https://www.google.com/imghp';
}
