# Proxy configuration for the Illumio App for ServiceNow

This guide explains how the Illumio App for ServiceNow (scope `x_illu2_illumio`) reaches the
Illumio PCE through an HTTP proxy, how to configure it, and how to troubleshoot it.

> **TL;DR**
> 1. The app **does not read `https_proxy` / `http_proxy` / `no_proxy`**, and it does not read the
>    JVM properties `-Dhttps.proxyHost` / `-Dhttps.proxyPort` either.
> 2. Configure the proxy in the MID Server **`config.xml`** with `mid.proxy.*`, then restart the MID Server.
> 3. Tick **Enable Proxy between PCE and MID server** on the Illumio PCE configuration record.
> 4. Make sure the proxy allows `CONNECT` to the PCE **port** (often 8443, not 443).

---

## 1. Network paths

All traffic to the PCE starts on the **MID Server**. The ServiceNow instance never connects to the PCE directly.

```
                       (A) MID Server <-> ServiceNow instance
  ┌────────────────┐  ─────────────────────────────────────────▶  ┌──────────────────────┐
  │                │   job logs, cancel checks, results            │ ServiceNow instance  │
  │   MID Server   │                                               └──────────────────────┘
  │ (Illumio MID   │   (B) MID Server -> PCE  (JavascriptProbes)   ┌──────────────────────┐
  │  scripts)      │  ─────────────────────────────────────────▶  │     Illumio PCE      │
  │                │   (C) MID Server -> PCE  (RESTMessageV2)      │  e.g. :8443          │
  └────────────────┘  ─────────────────────────────────────────▶  └──────────────────────┘
```

| Path | What uses it | HTTP stack | Proxy taken from | Controlled by the PCE checkbox? |
|---|---|---|---|---|
| **A** MID → instance (Illumio scripts) | Job log updates, cancel checks and log pushes in `IllumioPCEUtils`, `IllumioLogUtil`, `IllumioManageAsyncJobs` and `IllumioUpdateWorkloads` | Apache Commons HttpClient 3.x (`IllumioHTTPClient`) | `mid.proxy.*` in `config.xml` | No. Used whenever `mid.proxy.use_proxy=true` |
| **A** MID → instance (MID platform) | The MID Server's own ECC queue polling | ServiceNow MID platform | `mid.proxy.*` in `config.xml` | No |
| **B** MID → PCE (probes) | Connectivity check, discovery, workload/label sync, async jobs (`IllumioAuthenticateToPCE`, `IllumioUpdateWorkloads`, `IllumioManageAsyncJobs`) | Apache Commons HttpClient 3.x (`IllumioHTTPClient`) | `mid.proxy.*` in `config.xml` | **Yes**. Needs **Enable Proxy between PCE and MID server** |
| **C** MID → PCE (REST messages) | Label dimensions, labels and label groups (`IllumioUtils.makeRestCall`, REST messages run with `setMIDServer`) | ServiceNow RESTProbe on the MID Server | `mid.proxy.*` in `config.xml` | No. Follows the MID Server proxy setting |

All three paths use a proxy only when it is set in `config.xml` with `mid.proxy.*`.

---

## 2. Why `https_proxy` is ignored

- **Java ignores proxy environment variables.** Java never reads `http_proxy`, `https_proxy` or
  `no_proxy` (in either case). The MID Server is a Java process, so setting these variables on the
  host or service has no effect on it.
- **The app's HTTP client ignores JVM proxy properties.** `IllumioHTTPClient` is built on
  Apache Commons HttpClient 3.x (`org.apache.commons.httpclient.HttpClient`). That library ignores
  the `http(s).proxyHost`, `http(s).proxyPort` and `http.nonProxyHosts` system properties and the
  default `java.net.ProxySelector`. It only uses a proxy that the code sets explicitly.
- **The code only sets one kind of proxy.** `IllumioHTTPClient._getProxy()` reads exactly these
  `config.xml` parameters: `mid.proxy.use_proxy`, `mid.proxy.host`, `mid.proxy.port`,
  `mid.proxy.username` and `mid.proxy.password`.

So exporting `https_proxy`, or adding `-Dhttps.proxyHost` to `wrapper-override.conf`, changes nothing.
Configure the proxy as described in section 3.

---

## 3. Configuration

### 3.1 Turn `https_proxy` into MID Server parameters

If your environment defines

```
https_proxy=http://svc-mid:S3cr%40t@proxy.corp.example:3128
```

the equivalent MID Server parameters are:

| `https_proxy` part | MID Server parameter | Value |
|---|---|---|
| (proxy present) | `mid.proxy.use_proxy` | `true` |
| host | `mid.proxy.host` | `proxy.corp.example` |
| port | `mid.proxy.port` | `3128` |
| user | `mid.proxy.username` | `svc-mid` |
| password (URL-decoded) | `mid.proxy.password` | `S3cr@t` |

Notes:

- Use the host name or IP **without** a scheme. Write `proxy.corp.example`, not `http://proxy.corp.example`.
- URL-decode the password. `%40` becomes `@`.
- The connection to the proxy itself is always plain HTTP, and `https://` tunnels through it with
  `CONNECT`. A proxy that only accepts TLS on its listening port (`https_proxy=https://…`) is **not supported**.

### 3.2 Edit `config.xml`

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
`config.xml`. You can instead set these values as MID Server configuration parameters in the
instance (*MID Server → Servers → \<your MID\> → Configuration Parameters*), but a MID restart is
still recommended.

These settings also apply to the MID Server's own connection to the instance (path A). The proxy
therefore has to allow the instance (`*.service-now.com` or your custom domain) as well as the PCE.

### 3.3 Enable the proxy for PCE traffic

In ServiceNow, open **Illumio → PCE Configuration**, select the configuration, tick **Enable Proxy
between PCE and MID server**, and save.

| `mid.proxy.use_proxy` | Checkbox | MID → instance | MID → PCE (path B) | MID → PCE (path C) |
|---|---|---|---|---|
| not `true` | off | direct | direct | direct |
| not `true` | **on** | direct | direct. Warning: *"Proxy is not configured on MID Server and enabled…"* | direct |
| `true` | off | proxy | **direct** | proxy |
| `true` | **on** | proxy | proxy | proxy |

The checkbox has **no default value**, so new configurations start with it unticked.

Leave the checkbox **off** only when the MID Server needs the proxy to reach the instance but can
reach the PCE directly. The label/label-group REST calls (path C) still use the MID proxy in that
case, so the proxy must allow the PCE either way.

### 3.4 Proxy-side requirements

| Requirement | Why |
|---|---|
| `CONNECT` must be allowed to the **PCE port** | PCEs usually listen on **8443** (SaaS and on-prem). Many proxies, including Squid's default `SSL_ports` ACL, only allow `CONNECT` to 443 and answer **403** otherwise. |
| The PCE FQDN must be allowlisted | For example `*.illum.io` for SaaS, or your on-prem PCE FQDN. |
| The ServiceNow instance must be allowlisted | It is needed for path A. |
| Proxy auth must be **Basic**, **Digest** or **NTLMv1** | Commons HttpClient 3.x cannot do Kerberos/Negotiate or NTLMv2. Use a service account with Basic auth, or an IP-based allow rule for the MID host. |
| With TLS inspection, import the proxy's CA into the MID JRE truststore | Otherwise the PCE connection fails with `SSLHandshakeException` / `PKIX path building failed`. Import the CA into `<MID install dir>/agent/jre/lib/security/cacerts` (`keytool -importcert`) and restart the MID. |

### 3.5 Excluding hosts (`no_proxy`)

The app has no equivalent of `no_proxy`. Once `mid.proxy.use_proxy=true`, the Illumio scripts send
all instance traffic through the proxy. PCE traffic on path B goes through it only when the checkbox
is ticked. To reach a PCE without the proxy, untick the checkbox. Path C still uses the proxy, as
noted in 3.3.

---

## 4. Verification

1. In ServiceNow, open the PCE configuration and click **Check PCE Configuration**. This queues the
   `IllumioAuthenticateToPCE` probe on the MID.
2. Open the job under **Illumio → Scheduled Jobs** and read the **Logs** field.
3. On the MID host, read `<MID install dir>/agent/logs/agent0.log.0`. Every app message carries the
   `IllumioLogs` prefix:

   ```bash
   grep "IllumioLogs" agent/logs/agent0.log.0 | tail -50
   ```

   Debug lines only appear when the MID Server configuration parameter `debug.logging` is `true`.
   With that set and a working setup you see:

   ```
   >>> DEBUG: IllumioLogs:[<job sys_id>][MID.IllumioHTTPClient] Proxy is configured on MID Server and enabled for connecting to PCE. Proceeding to use proxy to connect with PCE and ServiceNow instance.
   >>> DEBUG: IllumioLogs:[<job sys_id>][MID.IllumioHTTPClient] HTTP GET Call complete, status: 200
   ```

   Warnings and errors are also pushed to the instance's application log (`syslog_app_scope`).
   Filter on messages starting with `[<job sys_id>]`.

4. To test outside the app, run this from the MID host with the same settings. It shows whether the
   proxy allows `CONNECT` to the PCE port:

   ```bash
   curl -v -x http://proxy.corp.example:3128 -U 'svc-mid:S3cr@t' \
        -u '<api_key_user>:<api_secret>' \
        https://pce.example.com:8443/api/v2/orgs/<org_id>/labels?max_results=1
   ```

> **Caveat:** the job log lines *"Validated the connectivity between MID server and ServiceNow
> through proxy"* and *"…the PCE through proxy"* are written **before** any request is made, and also
> appear when `mid.proxy.use_proxy=false`. Do not take them as proof that the proxy works. Only
> *"Successfully authenticated the PCE credentials"* confirms that it does.

---

## 5. Troubleshooting

| Symptom (job log / `agent0.log`) | Likely cause | Fix |
|---|---|---|
| Job log: *"Authentication failed with PCE. Message: Cannot find PCE \<url\>"* | **Any** connection-level failure. The app reports every exception as status 0. | Look in `agent0.log` for `PCE request failed : Exception` to find the real cause (rows below). |
| `java.net.UnknownHostException` | The MID cannot resolve the PCE and no proxy was used. The usual cause is that only `https_proxy` is set. | Configure `mid.proxy.*` (3.2) and tick the checkbox (3.3). |
| `java.net.ConnectException: Connection refused` or `SocketTimeoutException` / `connect timed out` | A direct connection is blocked by the firewall, or the proxy host/port is wrong. | Check `mid.proxy.host`/`port` and the checkbox. |
| *"Connectivity check to PCE failed. Response status code: 403"* (from the proxy) | The proxy refuses `CONNECT` to the PCE port or host. | Allow `CONNECT` to the PCE port (8443) and the PCE FQDN (3.4). |
| *"…Response status code: 407"* | Proxy authentication failed or uses an unsupported scheme. | Check `mid.proxy.username`/`password`. Basic, Digest or NTLMv1 only. |
| `SSLHandshakeException`, `PKIX path building failed` | The proxy does TLS inspection and its CA is not trusted. | Import the proxy CA into the MID JRE truststore (3.4). |
| *"Proxy is not configured on MID Server and enabled for connecting to PCE"* | The checkbox is on but `mid.proxy.use_proxy` is not `true`. | Configure `config.xml` (3.2). |
| *"Proxy is configured on MID Server and disabled for connecting to PCE"* | The MID has a proxy but the checkbox is off, so PCE traffic goes direct. | Tick the checkbox if the PCE is only reachable through the proxy. |

---

## 6. Known limitations and defects

These cannot be fixed by configuration. They are listed so you can recognise them:

1. **No support for `https_proxy`, `no_proxy` or JVM proxy properties.** See section 2. Use `mid.proxy.*`.
2. **Connection errors are reported as "Cannot find PCE".** `IllumioHTTPClient._executeMethod`
   catches every exception and returns status 0. The real exception is only in `agent0.log`.
3. **The connectivity-check log can be wrong about the proxy.** `IllumioAuthenticateToPCE` tests
   `mid.proxy.use_proxy` for truthiness, and the string `"false"` passes that test. It also writes
   "Validated…" lines without testing anything (section 4).
4. **Proxy authentication schemes.** Only Basic, Digest and NTLMv1 work (Commons HttpClient 3.x).

### Source references

| Component | File (`15314f1ddb882700dc9fabc5ca961943/update/…`) |
|---|---|
| `IllumioHTTPClient` (proxy selection: `_getProxy`) | `ecc_agent_script_include_6559a58adb4c6700dc9fabc5ca961943.xml` |
| `IllumioHttpIncludes` (Commons HttpClient 3.x imports) | `ecc_agent_script_include_962be58adb4c6700dc9fabc5ca96199e.xml` |
| `IllumioAuthenticateToPCE` (Check PCE Configuration probe) | `ecc_agent_script_include_e1ecfc601b64301046dba9f6624bcb49.xml` |
| `IllumioPCEUtils` (cancel checks, job logs) | `ecc_agent_script_include_93966d1f1b20381046dba9f6624bcb74.xml` |
| `IllumioAddToECCQueue` (passes the checkbox as `glide.jms.enable_pce_mid_proxy`) | `sys_script_include_*` containing `IllumioAddToECCQueue` |
| Checkbox field definition | `sys_dictionary_x_illu2_illumio_illumio_pce_conf_enable_proxy_between_pce_and_mid_server.xml` |
