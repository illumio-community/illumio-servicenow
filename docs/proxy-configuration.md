# Proxy configuration for the Illumio App for ServiceNow

This guide explains how the Illumio App for ServiceNow (scope `x_illu2_illumio`) reaches the
Illumio PCE through an HTTP proxy, how to configure it, and how to troubleshoot it.

> **TL;DR**
> 1. **Recommended:** configure the proxy in the MID Server **`config.xml`** (`mid.proxy.*`) and restart the MID Server.
>    This covers every network path.
> 2. Tick **Enable Proxy between PCE and MID server** on the Illumio PCE configuration record.
> 3. If `mid.proxy.*` is not set, the MID scripts that call the PCE fall back to the JVM properties
>    `-Dhttps.proxyHost`/`-Dhttps.proxyPort`, and then to the environment variable `https_proxy`
>    (honouring `http.nonProxyHosts` / `no_proxy`). See section 2 for which paths the fallback covers.
> 4. Make sure the proxy allows `CONNECT` to the PCE **port** (often 8443, not 443).
> 5. After **Check PCE Configuration**, the job log says exactly which proxy was used and where it came from.

---

## 1. Network paths

All traffic to the PCE starts on the **MID Server**. The ServiceNow instance never connects to the PCE directly.

```
                       (A) MID Server <-> ServiceNow instance
  ┌────────────────┐  ─────────────────────────────────────────▶  ┌──────────────────────┐
  │                │   job logs, cancel checks, log pushes         │ ServiceNow instance  │
  │   MID Server   │                                               └──────────────────────┘
  │ (Illumio MID   │   (B) MID Server -> PCE  (JavascriptProbes)   ┌──────────────────────┐
  │  scripts)      │  ─────────────────────────────────────────▶  │     Illumio PCE      │
  │                │   (C) MID Server -> PCE  (RESTMessageV2)      │  e.g. :8443          │
  └────────────────┘  ─────────────────────────────────────────▶  └──────────────────────┘
```

| Path | What uses it | HTTP stack | Proxy taken from | Controlled by the PCE checkbox? |
|---|---|---|---|---|
| **A** MID → instance (Illumio scripts) | Job log updates, cancel checks and log pushes (`IllumioPCEUtils`, `IllumioLogUtil`, `IllumioManageAsyncJobs`, `IllumioUpdateWorkloads`) | Apache Commons HttpClient 3.x (`IllumioHTTPClient`) | `mid.proxy.*` only | No. Used whenever `mid.proxy.use_proxy=true` |
| **A** MID → instance (MID platform) | The MID Server's own ECC queue polling | ServiceNow MID platform | `mid.proxy.*` only | No |
| **B** MID → PCE (probes and Flow actions) | Connectivity check, discovery, workload/label sync, async jobs (`IllumioAuthenticateToPCE`, `IllumioUpdateWorkloads`, `IllumioManageAsyncJobs`, Flow Designer actions that build an `IllumioHTTPClient`) | Apache Commons HttpClient 3.x (`IllumioHTTPClient`) | `mid.proxy.*` → JVM properties → `https_proxy` (section 2) | **Yes**. Needs **Enable Proxy between PCE and MID server** |
| **C** MID → PCE (REST messages) | Label dimensions, labels and label groups (`IllumioUtils.makeRestCall`, REST messages run with `setMIDServer`) | ServiceNow RESTProbe on the MID Server | `mid.proxy.*` only | No. Follows the MID Server proxy setting |

Paths **A** and **C** only use a proxy set in `config.xml` with `mid.proxy.*`, which is why that is the recommended setup.
Path A deliberately ignores `https_proxy` because the MID Server itself does: the instance is
reachable the same way the MID Server already reaches it.

---

## 2. How the proxy for PCE traffic (path B) is chosen

`IllumioHTTPClient._getProxy()` runs every time a PCE client is created. The first source that
defines a proxy wins:

| # | Source | Settings read | Exclusions honoured |
|---|---|---|---|
| 1 | MID Server `config.xml` | `mid.proxy.use_proxy=true`, `mid.proxy.host`, `mid.proxy.port`, `mid.proxy.username`, `mid.proxy.password` | none (all PCE traffic goes through the proxy) |
| 2 | JVM system properties | `https.proxyHost`, `https.proxyPort` (default 443), optional `https.proxyUser` / `https.proxyPassword`. Uses `http.*` for `http://` PCE URLs (default port 80). | `http.nonProxyHosts` (`|`-separated, `*` wildcard) |
| 3 | Environment of the MID Server process | `https_proxy`, then `HTTPS_PROXY`. Uses `http_proxy` / `HTTP_PROXY` for `http://` PCE URLs. | `no_proxy`, then `NO_PROXY` |

Then the **Enable Proxy between PCE and MID server** checkbox decides:

| Proxy found? | Checkbox | Result for PCE traffic | Logged as |
|---|---|---|---|
| no | off | direct | debug |
| no | **on** | direct | **warning**: *"…is checked but no proxy was found…"* |
| yes, from `mid.proxy.*` | off | **direct** (a supported setup: proxy to the instance, PCE direct) | debug: *"…a proxy is configured on the MID Server (…) but … is unchecked"* |
| yes, from JVM properties or `https_proxy` | off | **direct** | **warning**: same message |
| yes, but the PCE host matches an exclusion | on | direct | info: *"…matches proxy exclusion "…"…"* |
| yes | **on** | **through the proxy** | info: *"PCE connection: using proxy host:port (from …)"* |

### Why Java needs this

Java never reads `http_proxy` / `https_proxy` / `no_proxy` by itself. The app's HTTP library,
Commons HttpClient 3.x, also ignores the JVM proxy properties and `java.net.ProxySelector`. The app
therefore reads these sources explicitly, as described above. Before this change it only read `mid.proxy.*`.

### Supported `https_proxy` / `no_proxy` syntax

| Form | Example | Notes |
|---|---|---|
| host:port | `proxy.corp.example:3128` | |
| URL | `http://proxy.corp.example:3128/` | The path is ignored |
| with credentials | `http://svc-mid:S3cr%40t@proxy.corp.example:3128` | Credentials are URL-decoded (`%40` → `@`) |
| IPv6 | `http://[fd00::1]:3128` | |
| no port | `http://proxy.corp.example` | Defaults to 80 (443 for `https://`) |
| `https://` proxy | `https://proxy:8443` | **Warning**: the proxy is still spoken to in plain HTTP. TLS to the proxy itself is not supported. |
| `socks://`, `socks5://` | | **Rejected** with an error. Only HTTP proxies are supported. |

`no_proxy` entries are separated by commas or whitespace and are case-insensitive:
`*` (everything), `example.com` / `.example.com` / `*.example.com` (the domain and all subdomains),
`host:8443` (that port only), `10.0.0.0/8` (IPv4 CIDR, when the PCE URL uses an IPv4 address).

---

## 3. Configuration

### 3.1 Option A (recommended): MID Server `config.xml`

On the MID Server host, edit `<MID install dir>/agent/config.xml`:

```xml
<parameter name="mid.proxy.use_proxy" value="true"/>
<parameter name="mid.proxy.host"      value="proxy.corp.example"/>
<parameter name="mid.proxy.port"      value="3128"/>
<!-- only if the proxy requires authentication -->
<parameter name="mid.proxy.username"  value="svc-mid"/>
<parameter name="mid.proxy.password"  value="S3cr@t"/>
```

Then **restart the MID Server service**. On startup the MID Server encrypts `mid.proxy.password` in
`config.xml`. You can instead set these values as MID Server configuration parameters in the instance
(*MID Server → Servers → \<your MID\> → Configuration Parameters*).

To translate an existing `https_proxy=http://svc-mid:S3cr%40t@proxy.corp.example:3128`:

| `https_proxy` part | MID Server parameter | Value |
|---|---|---|
| (proxy present) | `mid.proxy.use_proxy` | `true` |
| host | `mid.proxy.host` | `proxy.corp.example` (no scheme) |
| port | `mid.proxy.port` | `3128` |
| user | `mid.proxy.username` | `svc-mid` |
| password (URL-decoded) | `mid.proxy.password` | `S3cr@t` |

These settings also apply to the MID Server's own connection to the instance (path A). The proxy
therefore has to allow the instance (`*.service-now.com` or your custom domain) as well as the PCE.

### 3.2 Option B: `https_proxy` in the MID Server service environment

Use this when the MID Server reaches the instance **directly** and only the PCE needs the proxy, or
when proxy settings are managed centrally as environment variables. It covers path B only. Path C
(label/label-group REST calls) still needs Option A if the PCE is only reachable through the proxy.

The variable must be set **for the MID Server service process**, not only in a login shell:

- **Linux (systemd):** `sudo systemctl edit <mid service>` and add
  ```ini
  [Service]
  Environment="https_proxy=http://proxy.corp.example:3128"
  Environment="no_proxy=localhost,127.0.0.1,.corp.example"
  ```
  Then run `sudo systemctl restart <mid service>`.
- **Windows:** set system environment variables (*System Properties → Environment Variables → System
  variables*) and restart the MID Server service. Alternatively, add a `REG_MULTI_SZ` value
  `Environment` under `HKLM\SYSTEM\CurrentControlSet\Services\<mid service>`.

### 3.3 Option C: JVM properties

Add these to `<MID install dir>/agent/conf/wrapper-override.conf`, using unused index numbers:

```properties
wrapper.java.additional.20=-Dhttps.proxyHost=proxy.corp.example
wrapper.java.additional.21=-Dhttps.proxyPort=3128
wrapper.java.additional.22=-Dhttp.nonProxyHosts=localhost|*.corp.example
```

Then restart the MID Server. These properties are JVM-wide and may affect other Java components of
the MID Server, so prefer Option A or B.

### 3.4 Enable the proxy for PCE traffic

In ServiceNow, open **Illumio → PCE Configuration**, select the configuration, tick **Enable Proxy
between PCE and MID server**, and save. The checkbox applies to every proxy source in section 2.
It has **no default value**, so new configurations start with it unticked.

### 3.5 Proxy-side requirements

| Requirement | Why |
|---|---|
| `CONNECT` must be allowed to the **PCE port** | PCEs usually listen on **8443**. Many proxies, including Squid's default `SSL_ports` ACL, only allow `CONNECT` to 443 and answer **403** otherwise. |
| The PCE FQDN must be allowlisted | For example `*.illum.io` for SaaS, or your on-prem PCE FQDN. |
| The ServiceNow instance must be allowlisted | Needed when `mid.proxy.*` is used (path A). |
| Proxy auth must be **Basic**, **Digest** or **NTLMv1** | Commons HttpClient 3.x cannot do Kerberos/Negotiate or NTLMv2. Use a service account with Basic auth, or an IP-based allow rule for the MID host. |
| With TLS inspection, import the proxy's CA into the MID JRE truststore | Otherwise the connection fails with `SSLHandshakeException` / `PKIX path building failed`. Import the CA into `<MID install dir>/agent/jre/lib/security/cacerts` (`keytool -importcert`) and restart the MID. |

---

## 4. Verification

1. In ServiceNow, open the PCE configuration and click **Check PCE Configuration**. This queues the
   `IllumioAuthenticateToPCE` probe on the MID.
2. Open the job under **Illumio → Scheduled Jobs** and read the **Logs** field. It states the
   configuration actually in use. These lines are written before the test request, so they describe
   the configuration and do not prove that it works:

   ```
   No MID Server proxy (mid.proxy.* in config.xml) is configured; MID Server connects to ServiceNow directly
   PCE connection: using proxy proxy.corp.example:3128 (from environment variable https_proxy)
   Checking connectivity between MID Server and the PCE (https://pce.example.com:8443)
   Successfully authenticated the PCE credentials
   ```

   Only *"Successfully authenticated the PCE credentials"* confirms that the connection works.
3. On the MID host, `<MID install dir>/agent/logs/agent0.log.0` has the same decision, prefixed with
   `IllumioLogs` and the job sys_id:

   ```bash
   grep "IllumioLogs" agent/logs/agent0.log.0 | grep "IllumioHTTPClient" | tail -20
   ```

   Warnings and errors are also pushed to the instance's application log (`syslog_app_scope`).
   Filter on messages starting with `[<job sys_id>]`. Debug lines need the MID Server configuration
   parameter `debug.logging=true`.
4. To test outside the app, run this from the MID host with the same settings. It shows whether the
   proxy allows `CONNECT` to the PCE port:

   ```bash
   curl -v -x http://proxy.corp.example:3128 -U 'svc-mid:S3cr@t' \
        -u '<api_key_user>:<api_secret>' \
        https://pce.example.com:8443/api/v2/orgs/<org_id>/labels?max_results=1
   ```

---

## 5. Troubleshooting

| Symptom (job log / `agent0.log`) | Likely cause | Fix |
|---|---|---|
| *"PCE connection: direct connection: "Enable Proxy between PCE and MID server" is checked but no proxy was found"* | `https_proxy` is not visible to the MID **service** process (set only in a shell), or no proxy source is configured | Set it for the service (3.2) or use `config.xml` (3.1). Restart the MID. |
| *"PCE connection: direct connection: a proxy is configured on the MID Server (…) but … is unchecked"* | The checkbox is off | Tick it (3.4). |
| *"…matches proxy exclusion "…" (environment variable no_proxy)"* | The PCE host is listed in `no_proxy` / `http.nonProxyHosts` | Remove it from the list if the PCE must go through the proxy. |
| *"Could not connect to PCE … Error: java.net.UnknownHostException: …"* | The PCE host cannot be resolved. Usually the connection was direct when it should not have been. | Check the "PCE connection:" line, then sections 2 and 3. |
| *"… Error: java.net.ConnectException: Connection refused"* / *"SocketTimeoutException"* | The firewall blocks the direct connection, or the proxy host/port is wrong | Check the proxy host and port in the "PCE connection:" line. |
| *"Invalid Organisation ID, or the proxy … refused CONNECT to the PCE host/port"* (403) | The proxy denies `CONNECT` to port 8443 or the PCE FQDN, or the Org ID is wrong | Allow the PCE port and host (3.5). Then check the Org ID. |
| *"Proxy authentication failed (HTTP 407) for proxy …"* | Wrong credentials or an unsupported auth scheme | Fix the username/password. Basic, Digest or NTLMv1 only. |
| *"… Error: javax.net.ssl.SSLHandshakeException …"* / *"PKIX path building failed"* | The proxy does TLS inspection and its CA is not trusted | Import the proxy CA into the MID JRE truststore (3.5). |
| *"Invalid proxy configuration from … (host: "…", port: "…"). The proxy is ignored."* | Empty host or non-numeric port in that source | Correct the value. Resolution continues with the next source. |
| *"Ignoring environment variable https_proxy: unsupported proxy scheme "socks5://""* | A SOCKS proxy | Use an HTTP proxy. |
| Label dimension / label group sync fails, but **Check PCE Configuration** succeeds | Path C uses `mid.proxy.*` only and ignores `https_proxy` | Configure Option A (3.1). |

---

## 6. Known limitations

1. Paths A and C use `mid.proxy.*` only (section 1). The fallback to JVM properties and `https_proxy` applies to PCE calls made through `IllumioHTTPClient` (path B).
2. `mid.proxy.*` has no exclusion list. Exclusions work only with the JVM and environment sources.
3. Only HTTP proxies are supported. TLS to the proxy and SOCKS are not.
4. Proxy authentication supports Basic, Digest and NTLMv1 only (Commons HttpClient 3.x).
5. `no_proxy` CIDR entries match IPv4 addresses only.

### Source references

| Component | File (`15314f1ddb882700dc9fabc5ca961943/update/…`) |
|---|---|
| `IllumioHTTPClient` (proxy selection: `_getProxy`, `parseProxyUrl`, `matchNoProxy`) | `ecc_agent_script_include_6559a58adb4c6700dc9fabc5ca961943.xml` |
| `IllumioHttpIncludes` (Commons HttpClient 3.x imports) | `ecc_agent_script_include_962be58adb4c6700dc9fabc5ca96199e.xml` |
| `IllumioAuthenticateToPCE` (Check PCE Configuration probe) | `ecc_agent_script_include_e1ecfc601b64301046dba9f6624bcb49.xml` |
| `IllumioPCEUtils` (cancel checks, job logs) | `ecc_agent_script_include_93966d1f1b20381046dba9f6624bcb74.xml` |
| `IllumioAddToECCQueue` (passes the checkbox as `glide.jms.enable_pce_mid_proxy`) | `sys_script_include_*` containing `IllumioAddToECCQueue` |
| Checkbox field definition | `sys_dictionary_x_illu2_illumio_illumio_pce_conf_enable_proxy_between_pce_and_mid_server.xml` |
