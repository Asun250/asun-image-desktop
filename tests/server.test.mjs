import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createServer,APP_ID,BUILD} from '../server.mjs';
test('server is loopback-only, local static assets load and unsupported generation endpoints do not exist', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    assert.equal(server.address().address,'127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await (await fetch(base + '/health')).json();
    assert.deepEqual(health,{app:APP_ID,build:BUILD,generation:'image-api'});
    const home = await fetch(base);
    assert.equal(home.status,200);
    assert.match(await home.text(),/editor.mjs/);
    assert.match(home.headers.get('content-security-policy'),/connect-src 'self'/);
    assert.equal((await fetch(base+'/core.mjs')).status,200);
    assert.equal((await fetch(base+'/generate',{method:'POST'})).status,405);
    assert.equal((await fetch(base+'/generate')).status,404);
    assert.equal((await fetch(base+'/../package.json')).status,404);
    assert.equal((await fetch(base+'/%zz')).status,400);
    const foreignHostStatus = await new Promise((resolve,reject) => {
      const request = http.get(base+'/health',{headers:{Host:'outside.example'}},response => { response.resume(); resolve(response.statusCode); });
      request.on('error',reject);
    });
    assert.equal(foreignHostStatus,403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
