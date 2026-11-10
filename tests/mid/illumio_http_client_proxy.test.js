// Harness: evaluates IllumioHTTPClient from the XML with stubbed MID / Java APIs.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

// Usage: node tests/mid/illumio_http_client_proxy.test.js   (no dependencies; Node 16+)
const path = require('path');
const repo = process.argv[2] || path.resolve(__dirname, '../..');
const xml = fs.readFileSync(repo + '/15314f1ddb882700dc9fabc5ca961943/update/ecc_agent_script_include_6559a58adb4c6700dc9fabc5ca961943.xml', 'utf8');
const script = xml.split('<script><![CDATA[')[1].split(']]></script>')[0];

function load(cfg) {
    const logs = [];
    const calls = { setProxy: null, proxyCreds: null };
    const logger = function () {};
    ['_info', '_debug', '_warning', '_error', '_except'].forEach(l => {
        logger.prototype[l] = function (m) { logs.push(l + ' ' + m); };
    });
    const ctx = {
        ms: { include() {}, getConfigParameter: n => (cfg.mid || {})[n] === undefined ? null : cfg.mid[n] },
        Packages: { java: { lang: {
            System: {
                getProperty: n => (cfg.props || {})[n] === undefined ? null : cfg.props[n],
                getenv: n => (cfg.env || {})[n] === undefined ? null : cfg.env[n]
            },
            Thread: { sleep() {} }
        } } },
        Class: { create: () => function () { this.initialize.apply(this, arguments); } },
        IllumioLogUtil: logger,
        HttpClient: function () {
            this.getParams = () => ({ setAuthenticationPreemptive() {} });
            this.getState = () => ({ setCredentials() {}, setProxyCredentials(scope, c) { calls.proxyCreds = c; } });
            this.getHostConfiguration = () => ({ setProxy(h, p) { calls.setProxy = [h, p]; } });
        },
        AuthScope: function (h, p) { this.h = h; this.p = p; },
        UsernamePasswordCredentials: function (u, p) { this.u = u; this.p = p; },
        DEFAULT_RETRY_PARAMS: { http_retry_count: 5, http_retry_interval_increment: 30, http_retry_interval_max: 300 },
        MIN_PCE_CALL_INTERVAL_MS: 0,
        RETRY_CODES: [429],
        IOUtils: {}
    };
    ctx.AuthScope.ANY = {};
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    return { ctx, logs, calls };
}

const RETRY = { http_retry_count: 1, http_retry_interval_increment: 1, http_retry_interval_max: 1 };
function client(cfg, url, flag) {
    const env = load(cfg);
    const c = new env.ctx.IllumioHTTPClient(url, 'u', 'p', 443, flag, RETRY);
    return { c, logs: env.logs, calls: env.calls, ctx: env.ctx };
}
const MID = { 'mid.proxy.use_proxy': 'true', 'mid.proxy.host': 'midproxy', 'mid.proxy.port': '3128', 'mid.proxy.username': '', 'mid.proxy.password': '' };
const PCE = 'https://pce.example.com:8443';
let n = 0;
function t(name, fn) { fn(); n++; console.log('ok', name); }

// --- MID config.xml source (unchanged behaviour) ---
t('mid proxy used for PCE when flag on', () => {
    const r = client({ mid: MID }, PCE, 'true');
    assert.deepStrictEqual(r.calls.setProxy, ['midproxy', 3128]);
    assert.strictEqual(r.calls.proxyCreds, null, 'no creds for empty username');
    assert.match(r.c.proxyDecision, /using proxy midproxy:3128 \(from MID Server config.xml/);
});
t('mid proxy credentials set when username present', () => {
    const r = client({ mid: Object.assign({}, MID, { 'mid.proxy.username': 'svc', 'mid.proxy.password': 'pw' }) }, PCE, 'true');
    assert.strictEqual(r.calls.proxyCreds.u, 'svc'); assert.strictEqual(r.calls.proxyCreds.p, 'pw');
});
t('mid proxy wins over env', () => {
    const r = client({ mid: MID, env: { https_proxy: 'http://envproxy:8080' } }, PCE, 'true');
    assert.strictEqual(r.calls.setProxy[0], 'midproxy');
});
t('flag "1" (GlideRecord getValue) enables proxy', () => {
    assert.ok(client({ mid: MID }, PCE, '1').c.proxy);
});
t('flag "false"/"0"/false disables mid proxy for PCE quietly (debug only)', () => {
    ['false', '0', false].forEach(f => {
        const r = client({ mid: MID }, PCE, f);
        assert.strictEqual(r.c.proxy, null);
        assert.match(r.c.proxyDecision, /unchecked/);
        assert.ok(r.logs.some(l => l.startsWith('_debug') && /unchecked/.test(l)));
        assert.ok(!r.logs.some(l => l.startsWith('_warning')), 'no warning for deliberate setup');
    });
});
t('instance client uses mid proxy', () => {
    const r = client({ mid: MID }, 'https://x.service-now.com', null);
    assert.strictEqual(r.c.proxy.host, 'midproxy');
    assert.strictEqual(r.logs.length, 0, 'instance client must not log');
});
t('instance client ignores env and JVM proxies', () => {
    const r = client({ env: { https_proxy: 'http://envproxy:8080' }, props: { 'https.proxyHost': 'jvm' } }, 'https://x.service-now.com', null);
    assert.strictEqual(r.c.proxy, null);
    assert.strictEqual(r.calls.setProxy, null);
    assert.strictEqual(r.logs.length, 0);
});
t('invalid mid port falls through and logs error', () => {
    const r = client({ mid: Object.assign({}, MID, { 'mid.proxy.port': 'abc' }) }, PCE, 'true');
    assert.strictEqual(r.c.proxy, null);
    assert.ok(r.logs.some(l => l.startsWith('_error') && /Invalid proxy configuration/.test(l)));
});

// --- JVM system properties ---
t('JVM https.proxyHost used', () => {
    const r = client({ props: { 'https.proxyHost': 'jvmproxy', 'https.proxyPort': '8081' } }, PCE, 'true');
    assert.deepStrictEqual(r.calls.setProxy, ['jvmproxy', 8081]);
});
t('JVM default port 443', () => {
    assert.strictEqual(client({ props: { 'https.proxyHost': 'jvmproxy' } }, PCE, 'true').c.proxy.port, 443);
});
t('JVM http.* used for http target', () => {
    const r = client({ props: { 'http.proxyHost': 'h', 'https.proxyHost': 's' } }, 'http://pce.example.com:8080', 'true');
    assert.strictEqual(r.c.proxy.host, 'h'); assert.strictEqual(r.c.proxy.port, 80);
});
t('JVM http.nonProxyHosts bypass', () => {
    const r = client({ props: { 'https.proxyHost': 'jvmproxy', 'http.nonProxyHosts': 'localhost|*.example.com' } }, PCE, 'true');
    assert.strictEqual(r.c.proxy, null);
    assert.match(r.c.proxyDecision, /matches proxy exclusion "\*\.example\.com"/);
});
t('JVM wins over env', () => {
    assert.strictEqual(client({ props: { 'https.proxyHost': 'jvm' }, env: { https_proxy: 'envp:1' } }, PCE, 'true').c.proxy.host, 'jvm');
});

// --- environment variables ---
t('env https_proxy with encoded creds', () => {
    const r = client({ env: { https_proxy: 'http://svc%2Dmid:S3cr%40t@proxy.corp:3128/' } }, PCE, 'true');
    assert.deepStrictEqual(r.calls.setProxy, ['proxy.corp', 3128]);
    assert.strictEqual(r.calls.proxyCreds.u, 'svc-mid'); assert.strictEqual(r.calls.proxyCreds.p, 'S3cr@t');
    assert.ok(!/S3cr/.test(r.c.proxyDecision), 'password must not be logged');
    assert.match(r.c.proxyDecision, /environment variable https_proxy/);
});
t('env HTTPS_PROXY uppercase', () => {
    assert.strictEqual(client({ env: { HTTPS_PROXY: 'proxy:8080' } }, PCE, 'true').c.proxy.port, 8080);
});
t('env lowercase preferred', () => {
    assert.strictEqual(client({ env: { HTTPS_PROXY: 'upper:1', https_proxy: 'lower:2' } }, PCE, 'true').c.proxy.host, 'lower');
});
t('env http_proxy only used for http targets', () => {
    assert.strictEqual(client({ env: { http_proxy: 'p:1' } }, PCE, 'true').c.proxy, null);
    assert.strictEqual(client({ env: { http_proxy: 'p:1' } }, 'http://pce:8080', 'true').c.proxy.host, 'p');
});
t('env no_proxy bypass', () => {
    const r = client({ env: { https_proxy: 'p:1', no_proxy: 'localhost, .example.com' } }, PCE, 'true');
    assert.strictEqual(r.c.proxy, null);
    assert.match(r.c.proxyDecision, /no_proxy/);
});
t('env NO_PROXY uppercase bypass', () => {
    assert.strictEqual(client({ env: { https_proxy: 'p:1', NO_PROXY: 'pce.example.com' } }, PCE, 'true').c.proxy, null);
});
t('env no_proxy non-match keeps proxy', () => {
    assert.strictEqual(client({ env: { https_proxy: 'p:1', no_proxy: 'other.com' } }, PCE, 'true').c.proxy.host, 'p');
});
t('env socks proxy rejected with error', () => {
    const r = client({ env: { https_proxy: 'socks5://p:1080' } }, PCE, 'true');
    assert.strictEqual(r.c.proxy, null);
    assert.ok(r.logs.some(l => l.startsWith('_error') && /unsupported proxy scheme/.test(l)));
});
t('env https:// proxy warns but works', () => {
    const r = client({ env: { https_proxy: 'https://p:8443' } }, PCE, 'true');
    assert.strictEqual(r.c.proxy.port, 8443);
    assert.ok(r.logs.some(l => l.startsWith('_warning') && /treated as http/.test(l)));
});
t('env proxy present but flag off -> direct + warning', () => {
    const r = client({ env: { https_proxy: 'p:1' } }, PCE, 'false');
    assert.strictEqual(r.c.proxy, null);
    assert.ok(r.logs.some(l => l.startsWith('_warning') && /unchecked/.test(l)));
});
t('flag on, nothing configured -> direct + warning', () => {
    const r = client({}, PCE, 'true');
    assert.strictEqual(r.c.proxy, null);
    assert.ok(r.logs.some(l => l.startsWith('_warning') && /no proxy was found/.test(l)));
});
t('flag off, nothing configured -> direct, no warning', () => {
    const r = client({}, PCE, 'false');
    assert.ok(!r.logs.some(l => l.startsWith('_warning')));
});

// --- pure helpers ---
const H = load({}).ctx.IllumioHTTPClient;
t('parseProxyUrl variants', () => {
    let p = H.parseProxyUrl('proxy.corp');
    assert.strictEqual(p.host, 'proxy.corp'); assert.strictEqual(p.port, '80');
    p = H.parseProxyUrl('http://[fd00::1]:3128');
    assert.strictEqual(p.host, 'fd00::1'); assert.strictEqual(p.port, '3128');
    p = H.parseProxyUrl('http://user@p:1');
    assert.strictEqual(p.username, 'user'); assert.strictEqual(p.password, '');
    p = H.parseProxyUrl('http://u:a:b@p:1');
    assert.strictEqual(p.password, 'a:b');
    p = H.parseProxyUrl('http://u:p@ss@p:1');
    assert.strictEqual(p.host, 'p'); assert.strictEqual(p.password, 'p@ss');
    assert.ok(H.parseProxyUrl('  ').error);
    assert.ok(H.parseProxyUrl('http://:8080').error);
});
t('matchNoProxy rules', () => {
    assert.strictEqual(H.matchNoProxy('pce.example.com', 8443, '*'), '*');
    assert.ok(H.matchNoProxy('pce.example.com', 8443, 'example.com'));
    assert.ok(H.matchNoProxy('pce.example.com', 8443, '*.example.com'));
    assert.ok(H.matchNoProxy('example.com', 8443, '.example.com'));
    assert.strictEqual(H.matchNoProxy('notexample.com', 8443, 'example.com'), null);
    assert.ok(H.matchNoProxy('pce.example.com', 8443, 'pce.example.com:8443'));
    assert.strictEqual(H.matchNoProxy('pce.example.com', 443, 'pce.example.com:8443'), null);
    assert.ok(H.matchNoProxy('10.1.2.3', 8443, '10.0.0.0/8'));
    assert.strictEqual(H.matchNoProxy('11.1.2.3', 8443, '10.0.0.0/8'), null);
    assert.ok(H.matchNoProxy('PCE.Example.COM', 1, 'pce.example.com'));
    assert.strictEqual(H.matchNoProxy('pce', 1, ''), null);
});
t('matchNonProxyHosts rules', () => {
    assert.ok(H.matchNonProxyHosts('pce.example.com', 'localhost|*.example.com'));
    assert.ok(H.matchNonProxyHosts('10.0.0.5', '10.*'));
    assert.strictEqual(H.matchNonProxyHosts('pceXexample.com', 'pce.example.com'), null, '. is literal');
    assert.strictEqual(H.matchNonProxyHosts('pce.example.com', ''), null);
});

// --- exception reporting ---
t('exception surfaces Java class + proxy in log and response', () => {
    const r = client({ env: { https_proxy: 'p:3128' } }, PCE, 'true');
    r.c.client.executeMethod = () => { const e = new Error('wrapped'); e.javaException = { getClass: () => ({ getName: () => 'java.net.UnknownHostException' }), getMessage: () => 'pce.example.com' }; throw e; };
    const method = { getName: () => 'GET', setQueryString() {}, addRequestHeader() {}, releaseConnection() {} };
    const resp = r.c._executeMethod('/api', '', method);
    assert.strictEqual(resp.status, 0);
    assert.strictEqual(resp.error, 'java.net.UnknownHostException: pce.example.com');
    assert.ok(r.logs.some(l => /UnknownHostException: pce.example.com \(via proxy p:3128/.test(l)));
});
t('407 logs proxy auth hint', () => {
    const r = client({ env: { https_proxy: 'p:3128' } }, PCE, 'true');
    r.c.client.executeMethod = () => {};
    const method = { getName: () => 'GET', setQueryString() {}, addRequestHeader() {}, releaseConnection() {},
        getResponseBody: () => null, getResponseBodyAsString: () => '', getStatusCode: () => 407, getResponseHeaders: () => [] };
    const resp = r.c._executeMethod('/api', '', method);
    assert.strictEqual(resp.status, 407);
    assert.ok(r.logs.some(l => /Proxy authentication failed \(HTTP 407\)/.test(l)));
});

console.log(`\n${n} tests passed`);
