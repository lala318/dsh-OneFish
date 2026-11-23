/**
 * OneFish Core —— DSH 设置页客户端。
 *
 * 页面：概览 / 人格 / 记忆 / 配置 / 空闲钟 / 会话 / 自检。
 * 用 DSH 提供的 React，由 settings.section slot 注入；所有数据走本机回环 API。
 *
 * 约定：
 * - 每个页签自己负责空状态和出错提示，不让「加载中…」冒充结果；
 * - 写操作成功后一定回读一次服务端状态（不做乐观更新）；
 * - 配置保存后把服务端修正过的字段原样列出来，不假装用户填的都生效了。
 */
window.__ModuleLoader__.load({
  id: "onefish-core",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useState } = React;
    const API = "/dsh-onefish-core/api";

    async function api(path, options = {}) {
      const res = await fetch(`${API}${path}`, {
        headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
        ...options,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data;
    }

    const C = {
      card: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "12px 14px", background: "rgba(127,127,127,.03)" },
      label: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px" },
      hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", lineHeight: "16px" },
      input: { background: "transparent", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", color: "var(--dsw-alias-label-primary)", fontSize: "12.5px", padding: "6px 8px", fontFamily: "inherit", width: "100%", boxSizing: "border-box" },
      btn: { background: "#2f6fed", color: "#fff", border: "none", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "12.5px" },
      btn2: { background: "transparent", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "12.5px" },
      btnDanger: { background: "transparent", border: "1px solid var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", fontSize: "12px" },
      err: { color: "var(--dsw-alias-state-error-primary)", fontSize: "12px" },
      ok: { color: "#2fbf71", fontSize: "12px" },
      warn: { color: "#c98a1b", fontSize: "12px" },
      grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: "10px" },
      paste: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" },
    };

    // ── 小部件 ────────────────────────────────────────────────────
    function Row({ name, value }) {
      return h("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px", padding: "5px 0", borderBottom: ".5px solid var(--dsw-alias-border-l2)", fontSize: "12px" } },
        h("span", { style: { color: "var(--dsw-alias-label-tertiary)", flex: "0 0 auto" } }, name),
        h("span", { style: { textAlign: "right", wordBreak: "break-all" } }, String(value ?? "—")));
    }

    function Empty({ children }) {
      return h("div", { style: { ...C.label, padding: "20px 0", textAlign: "center", lineHeight: "18px" } }, children);
    }

    function Section({ title, desc, children }) {
      return h("div", { style: { ...C.card, marginBottom: "10px" } },
        h("div", { style: { fontWeight: 600, fontSize: "13px" } }, title),
        desc ? h("div", { style: { ...C.hint, marginTop: "3px" } }, desc) : null,
        h("div", { style: { ...C.grid, marginTop: "10px" } }, children));
    }

    function Field({ text, hint, children }) {
      return h("label", { style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" } },
        h("span", { style: C.label }, text),
        children,
        hint ? h("span", { style: C.hint }, hint) : null);
    }

    function numInput(value, onChange, opts = {}) {
      return h("input", {
        ...C.input,
        type: "number",
        value: value === undefined || value === null ? "" : value,
        min: opts.min,
        max: opts.max,
        step: opts.step || 1,
        onChange: (e) => onChange(e.target.value === "" ? "" : Number(e.target.value)),
      });
    }

    function textInput(value, onChange, placeholder) {
      return h("input", { ...C.input, type: "text", value: value || "", placeholder: placeholder || "", onChange: (e) => onChange(e.target.value) });
    }

    function toggle(checked, onChange, text) {
      return h("label", { style: { display: "flex", alignItems: "center", gap: "7px", fontSize: "12.5px", cursor: "pointer" } },
        h("input", { type: "checkbox", checked: checked === true, onChange: (e) => onChange(e.target.checked) }),
        text);
    }

    /** 不可变地写嵌套路径，例如 setPath(draft, "recall.topK", 4)。 */
    function setPath(root, path, value) {
      const [head, ...rest] = String(path).split(".");
      if (rest.length === 0) return { ...(root || {}), [head]: value };
      return { ...(root || {}), [head]: setPath((root || {})[head] || {}, rest.join("."), value) };
    }

    const STATUS = {
      pass: { color: "#2fbf71", text: "正常" },
      warn: { color: "#c98a1b", text: "注意" },
      fail: { color: "var(--dsw-alias-state-error-primary)", text: "异常" },
    };

    function OneFishCoreSection() {
      const [tab, setTab] = useState("overview");
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [warnings, setWarnings] = useState([]);

      const [overview, setOverview] = useState(null);
      const [diagnostics, setDiagnostics] = useState(null);

      const [persona, setPersona] = useState(null);
      const [personaDraft, setPersonaDraft] = useState("");

      const [memories, setMemories] = useState([]);
      const [memoryStats, setMemoryStats] = useState(null);
      const [memoryQuery, setMemoryQuery] = useState("");
      const [memoryTier, setMemoryTier] = useState("");
      const [newText, setNewText] = useState("");
      const [newTier, setNewTier] = useState("active");

      const [config, setConfig] = useState(null);
      const [configDraft, setConfigDraft] = useState(null);
      const [configFile, setConfigFile] = useState("");

      const [idle, setIdle] = useState(null);
      const [idlePreview, setIdlePreview] = useState("");

      const [sessions, setSessions] = useState(null);
      const [bootPreview, setBootPreview] = useState("");
      const [consolidateDay, setConsolidateDay] = useState("");
      const [bootstrapActions, setBootstrapActions] = useState([]);

      function flash(label) {
        setNotice(label);
        setWarnings([]);
      }

      function clearFlash() {
        setError("");
        setNotice("");
      }

      const loadCore = useCallback(async () => {
        const [o, p] = await Promise.all([api("/overview"), api("/persona")]);
        setOverview(o);
        setPersona(p);
        setPersonaDraft((prev) => (prev && prev !== p.text ? prev : p.text || ""));
      }, []);

      const loadMemory = useCallback(async (query, tier) => {
        const params = new URLSearchParams({ limit: "60" });
        if (query) params.set("q", query);
        if (tier) params.set("tier", tier);
        const data = await api(`/memory?${params.toString()}`);
        setMemories(data.entries || []);
        setMemoryStats(data.stats || null);
      }, []);

      const loadConfig = useCallback(async () => {
        const data = await api("/config");
        setConfig(data.config || null);
        setConfigDraft(data.config || null);
        setConfigFile(data.file || "");
      }, []);

      const loadIdle = useCallback(async () => {
        setIdle(await api("/idle/status"));
      }, []);

      const loadSessions = useCallback(async () => {
        setSessions(await api("/sessions"));
      }, []);

      const loadDiagnostics = useCallback(async () => {
        setDiagnostics(await api("/diagnostics"));
      }, []);

      const load = useCallback(async () => {
        clearFlash();
        try {
          await Promise.all([loadCore(), loadMemory(memoryQuery, memoryTier), loadConfig(), loadIdle(), loadSessions()]);
        } catch (e) {
          setError(String(e?.message || e));
        }
      }, [loadCore, loadMemory, loadConfig, loadIdle, loadSessions, memoryQuery, memoryTier]);

      useEffect(() => { void load(); }, [load]);

      // ── 人格 ────────────────────────────────────────────────────
      async function savePersona() {
        setBusy("persona"); clearFlash();
        try {
          const saved = await api("/persona", { method: "POST", body: JSON.stringify({ text: personaDraft }) });
          setPersona(saved);
          setPersonaDraft(saved.text || "");
          flash("人格卡已保存，下一轮对话生效");
          await loadCore();
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      // ── 记忆 ────────────────────────────────────────────────────
      async function searchMemory() {
        setBusy("memory-search"); clearFlash();
        try {
          await loadMemory(memoryQuery, memoryTier);
          setNotice(`筛出 ${memories.length} 条`);
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function resetMemoryFilter() {
        setMemoryQuery(""); setMemoryTier("");
        setBusy("memory-search"); clearFlash();
        try {
          await loadMemory("", "");
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function addMemory() {
        if (!newText.trim()) return;
        setBusy("memory"); clearFlash();
        try {
          await api("/memory", { method: "POST", body: JSON.stringify({ text: newText.trim(), tier: newTier, by: "owner" }) });
          setNewText("");
          flash("记忆已写入");
          await loadMemory(memoryQuery, memoryTier);
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function deleteMemory(id) {
        if (!window.confirm("删除这条记忆？设置页可以恢复（软删除）。")) return;
        setBusy(id); clearFlash();
        try {
          await api("/memory/delete", { method: "POST", body: JSON.stringify({ id }) });
          flash("已删除");
          await loadMemory(memoryQuery, memoryTier);
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function maintainMemory() {
        setBusy("memory-maintain"); clearFlash();
        try {
          const result = await api("/memory/maintain", { method: "POST", body: JSON.stringify({}) });
          flash(`维护完成：衰减 ${result.decayed ?? result.decay ?? "已执行"}，去重 ${result.deduped ?? "—"}`);
          await loadMemory(memoryQuery, memoryTier);
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      // ── 配置 ────────────────────────────────────────────────────
      function setConfigValue(path, value) {
        setConfigDraft((prev) => setPath(prev || {}, path, value));
      }

      async function saveConfig() {
        if (!configDraft) return;
        setBusy("config"); clearFlash();
        try {
          const result = await api("/config", { method: "POST", body: JSON.stringify({ config: configDraft }) });
          setConfig(result.config || configDraft);
          setConfigDraft(result.config || configDraft);
          setWarnings(result.warnings || []);
          const live = result.applied?.live || [];
          const restart = result.applied?.restart || [];
          const bits = [];
          if (live.length) bits.push(`${live.join("、")} 已立即生效`);
          if (restart.length) bits.push(`${restart.join("、")} 需要重启插件`);
          setNotice(bits.join("；") || "配置已保存");
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      function resetConfigDraft() {
        setConfigDraft(config);
        setWarnings([]);
        flash("已恢复为当前生效值");
      }

      // ── 空闲钟 ──────────────────────────────────────────────────
      function setIdleValue(path, value) {
        setConfigDraft((prev) => setPath(prev || {}, `idleClock.${path}`, value));
      }

      async function saveIdle() {
        if (!configDraft?.idleClock) return;
        setBusy("idle"); clearFlash();
        try {
          const result = await api("/idle/config", { method: "POST", body: JSON.stringify({ idleClock: configDraft.idleClock }) });
          setIdle(result);
          setWarnings([]);
          flash("空闲钟配置已保存，立即生效");
          await loadConfig();
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function previewIdle() {
        setBusy("idle-preview"); clearFlash();
        try {
          const data = await api("/idle/preview");
          setIdlePreview(String(data.text || "(空)"));
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function runIdle() {
        setBusy("idle-run"); clearFlash();
        try {
          const data = await api("/idle/run", { method: "POST" });
          flash(data.fired ? "空闲 prompt 已触发" : `未触发：${data.reason || "未知原因"}`);
          await loadIdle();
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      // ── 会话 ────────────────────────────────────────────────────
      async function loadBootPreview() {
        setBusy("bootpack"); clearFlash();
        try {
          const data = await api("/session/bootpack");
          setBootPreview(String(data.text || ""));
          flash(`开机包 ${data.chars || 0} 字`);
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function ensureSession() {
        setBusy("session-ensure"); clearFlash();
        try {
          const result = await api("/session/ensure", { method: "POST" });
          flash(result.created === false ? "今天的日会话已经在了" : "已新建今日会话");
          await loadSessions();
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function consolidate() {
        const day = consolidateDay.trim();
        if (!day) { setError("先填要整理的日期（YYYY-MM-DD）"); return; }
        setBusy("session-consolidate"); clearFlash();
        try {
          const result = await api("/session/consolidate", { method: "POST", body: JSON.stringify({ day }) });
          flash(result.skipped ? `跳过：${result.reason || "已整理过"}` : `已整理 ${day}`);
          await loadSessions();
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function retire(sessionId) {
        if (!window.confirm(`让会话 ${sessionId} 退役？这不会删档案。`)) return;
        setBusy("session-retire"); clearFlash();
        try {
          await api("/session/retire", { method: "POST", body: JSON.stringify({ sessionId }) });
          flash("会话已退役");
          await loadSessions();
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      // ── 首次使用：一键补齐 ──────────────────────────────────────
      async function runBootstrap() {
        setBusy("bootstrap"); clearFlash();
        try {
          const result = await api("/bootstrap", { method: "POST" });
          setBootstrapActions(result.actions || []);
          const done = result.actions?.filter((item) => item.status === "done").length || 0;
          flash(done ? `已自动补齐 ${done} 项` : "能自动做的都做过了");
          await load();
          await loadDiagnostics().catch(() => {});
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      // ── 渲染：概览 ──────────────────────────────────────────────
      function renderOverview() {
        if (!overview) return h(Empty, null, "加载中…");
        const components = overview.components || [];
        const needsSetup = overview.persona?.configured === false || !overview.session?.active;
        return h("div", null,
          needsSetup
            ? h("div", { style: { ...C.card, borderColor: "#2f6fed", marginBottom: "10px" } },
              h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, "这台还没配好"),
              h("div", { style: C.hint },
                overview.persona?.configured === false ? "人格卡还是空的 · " : "",
                !overview.session?.active ? "今天还没有日会话 · " : "",
                "点一下，能自动补的我来补，补不了的会写清楚缺什么。"),
              h("div", { style: { ...C.paste, marginTop: "8px" } },
                h("button", { style: C.btn, disabled: busy === "bootstrap", onClick: runBootstrap }, busy === "bootstrap" ? "处理中…" : "一键初始化"),
                h("span", { style: C.label }, "不会覆盖已有人格卡和配置文件")))
            : null,
          h("div", { style: C.grid },
            h("div", { style: C.card },
              h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "核心"),
              h(Row, { name: "数据目录", value: overview.home }),
              h(Row, { name: "人格", value: overview.persona?.name }),
              h(Row, { name: "人格字数", value: overview.persona?.chars }),
              h(Row, { name: "档案天数", value: overview.archive?.days ?? 0 })),
            h("div", { style: C.card },
              h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "会话"),
              h(Row, { name: "今日", value: overview.session?.currentDay }),
              h(Row, { name: "工作区", value: overview.session?.workspaceTitle }),
              h(Row, { name: "开机包", value: overview.session?.bootPackAt ? "已注入" : "未注入" }),
              h(Row, { name: "状态", value: overview.session?.active ? "active" : "未建立" })),
            h("div", { style: C.card },
              h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "记忆"),
              h(Row, { name: "总数", value: overview.memory?.total ?? 0 }),
              h(Row, { name: "core", value: overview.memory?.core ?? 0 }),
              h(Row, { name: "active", value: overview.memory?.active ?? 0 }),
              h(Row, { name: "knowledge", value: overview.memory?.knowledge ?? 0 }))),
          h("div", { style: { ...C.card, marginTop: "10px" } },
            h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, "频道组件"),
            components.length === 0
              ? h(Empty, null, "还没有组件登记。装好组件并重启后，这里会列出来。")
              : h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
                components.map((item) => h("div", { key: item.id || item.name, style: { display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12.5px", padding: "4px 0", borderBottom: ".5px solid var(--dsw-alias-border-l2)" } },
                  h("span", null, `${item.name || item.id || "未命名"}${item.version ? ` · v${item.version}` : ""}`),
                  h("span", { style: C.label }, item.kind || item.type || ""))))),
          h("div", { style: { ...C.hint, marginTop: "10px" } },
            "这是核心面板：只含人格 / 记忆 / 日会话；频道组件是可选件，装了什么这里就显示什么。"));
      }

      // ── 渲染：人格 ──────────────────────────────────────────────
      function renderPersona() {
        if (!persona) return h(Empty, null, "加载中…");
        const dirty = personaDraft !== (persona.text || "");
        return h("div", null,
          h("div", { style: { ...C.label, marginBottom: "6px" } }, `当前人格：${persona.name || "—"} · ${persona.source || "—"}`),
          h("textarea", {
            value: personaDraft,
            onChange: (e) => setPersonaDraft(e.target.value),
            style: { ...C.input, minHeight: "320px", lineHeight: "19px", resize: "vertical" },
          }),
          h("div", { style: { ...C.paste, marginTop: "10px" } },
            h("button", { style: C.btn, disabled: busy === "persona" || !personaDraft.trim(), onClick: savePersona }, busy === "persona" ? "保存中…" : "保存人格卡"),
            h("button", { style: C.btn2, disabled: !dirty, onClick: () => setPersonaDraft(persona.text || "") }, "撤销改动"),
            h("span", { style: C.label }, dirty ? "有未保存的改动" : "已与磁盘一致")),
          h("div", { style: { ...C.hint, marginTop: "6px" } },
            `人格卡上限由配置 personaMaxChars 决定，当前 ${overview?.persona?.chars ?? personaDraft.length} 字。保存后下一轮对话生效。`));
      }

      // ── 渲染：记忆 ──────────────────────────────────────────────
      function renderMemory() {
        const stats = memoryStats || overview?.memory || {};
        return h("div", null,
          h("div", { style: { ...C.paste, marginBottom: "10px" } },
            h("input", {
              style: { ...C.input, flex: "1 1 260px" },
              placeholder: "搜索记忆内容 / 标签",
              value: memoryQuery,
              onChange: (e) => setMemoryQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") void searchMemory(); },
            }),
            h("select", { style: { ...C.input, width: "140px" }, value: memoryTier, onChange: (e) => setMemoryTier(e.target.value) },
              h("option", { value: "" }, "全部层级"),
              h("option", { value: "core" }, "core"),
              h("option", { value: "active" }, "active"),
              h("option", { value: "knowledge" }, "knowledge")),
            h("button", { style: C.btn2, disabled: busy === "memory-search", onClick: searchMemory }, "搜索"),
            h("button", { style: C.btn2, disabled: busy === "memory-search", onClick: resetMemoryFilter }, "重置"),
            h("button", { style: C.btn2, disabled: busy === "memory-maintain", onClick: maintainMemory }, busy === "memory-maintain" ? "维护中…" : "跑一次维护")),
          h("div", { style: { ...C.paste, marginBottom: "10px" } },
            h("input", {
              style: { ...C.input, flex: "1 1 300px" },
              placeholder: "写一条记忆，例如：主人最近在重做设置页",
              value: newText,
              onChange: (e) => setNewText(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") void addMemory(); },
            }),
            h("select", { style: { ...C.input, width: "120px" }, value: newTier, onChange: (e) => setNewTier(e.target.value) },
              h("option", { value: "active" }, "active"),
              h("option", { value: "core" }, "core"),
              h("option", { value: "knowledge" }, "knowledge")),
            h("button", { style: C.btn, disabled: busy === "memory" || !newText.trim(), onClick: addMemory }, "写入")),
          h("div", { style: { ...C.label, marginBottom: "8px" } },
            `共 ${stats.total ?? memories.length} 条 · core ${stats.core ?? 0} · active ${stats.active ?? 0} · knowledge ${stats.knowledge ?? 0}`),
          memories.length === 0
            ? h(Empty, null, memoryQuery || memoryTier ? "这个筛选下没有记忆。" : "还没有记忆。先写一条，召回才有东西可挑。")
            : h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
              memories.map((item) => h("div", { key: item.id, style: { ...C.card, padding: "8px 10px" } },
                h("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "flex-start" } },
                  h("div", null,
                    h("span", { style: { fontSize: "10.5px", color: "var(--dsw-alias-label-tertiary)", marginRight: "6px" } },
                      `${item.tier}/${item.kind || "fact"}${item.importance ? ` · 重要度 ${item.importance}` : ""}`),
                    h("span", { style: { fontSize: "12.5px" } }, item.text)),
                  h("button", { style: C.btnDanger, disabled: busy === item.id, onClick: () => deleteMemory(item.id) }, "删除"))))));
      }

      // ── 渲染：配置 ──────────────────────────────────────────────
      function renderConfig() {
        if (!configDraft) return h(Empty, null, "加载中…");
        const c = configDraft;
        const dirty = JSON.stringify(c) !== JSON.stringify(config);
        const recall = c.recall || {};
        const embedding = c.embedding || {};
        return h("div", null,
          h("div", { style: { ...C.hint, marginBottom: "10px" } },
            `配置文件：${configFile || "(默认值，还没落盘)"}`),
          h(Section, { title: "基础", desc: "日切时间、预设与工作区。改完要重启插件。" },
            h(Field, { text: "日切小时（0–23）", hint: "过了这个点算新的一天" }, numInput(c.rolloverHour, (v) => setConfigValue("rolloverHour", v), { min: 0, max: 23 })),
            h(Field, { text: "预设 preset" }, textInput(c.preset, (v) => setConfigValue("preset", v), "onefish-core")),
            h(Field, { text: "标题前缀" }, textInput(c.titlePrefix, (v) => setConfigValue("titlePrefix", v), "OneFish")),
            h(Field, { text: "工作区标题" }, textInput(c.workspaceTitle, (v) => setConfigValue("workspaceTitle", v), "onefish")),
            h(Field, { text: "工作区路径", hint: "日会话落在哪个 DSH 工作区" }, textInput(c.workspacePath, (v) => setConfigValue("workspacePath", v), "留空用默认"))),
          h(Section, { title: "开机包与人格", desc: "开机包每轮注入，太长会吃 token。" },
            h(Field, { text: "开机包上限（字）" }, numInput(c.bootMaxChars, (v) => setConfigValue("bootMaxChars", v), { min: 1000, max: 12000, step: 100 })),
            h(Field, { text: "人格卡上限（字）" }, numInput(c.personaMaxChars, (v) => setConfigValue("personaMaxChars", v), { min: 200, max: 6000, step: 100 })),
            h(Field, { text: "日记摘要上限（字）" }, numInput(c.digestMaxChars, (v) => setConfigValue("digestMaxChars", v), { min: 200, max: 4000, step: 100 })),
            h(Field, { text: "单页历史条数" }, numInput(c.historyPageMessages, (v) => setConfigValue("historyPageMessages", v), { min: 1, max: 1000 })),
            h(Field, { text: "历史最多页数" }, numInput(c.historyMaxPages, (v) => setConfigValue("historyMaxPages", v), { min: 1, max: 200 }))),
          h(Section, { title: "整理与时间戳", desc: "自动整理把日会话压成记忆；关掉就全靠手动。" },
            h(Field, { text: "自动整理" }, toggle(c.autoConsolidate !== false, (v) => setConfigValue("autoConsolidate", v), "会话封存时自动整理")),
            h(Field, { text: "启动时补整理" }, toggle(c.consolidateOnBootstrap !== false, (v) => setConfigValue("consolidateOnBootstrap", v), "开机时补昨天没整理的")),
            h(Field, { text: "时间戳" }, toggle(c.timestamp?.enabled !== false, (v) => setConfigValue("timestamp.enabled", v), "每轮注入当前时间"))),
          h(Section, { title: "每轮记忆召回", desc: "回答前先捞几条旧记忆；关掉能省一点延迟。" },
            h(Field, { text: "启用召回" }, toggle(recall.enabled !== false, (v) => setConfigValue("recall.enabled", v), "每轮自动召回")),
            h(Field, { text: "条数 topK（1–6）" }, numInput(recall.topK, (v) => setConfigValue("recall.topK", v), { min: 1, max: 6 })),
            h(Field, { text: "向量最低分（0–1）" }, numInput(recall.minScore, (v) => setConfigValue("recall.minScore", v), { min: 0, max: 1, step: 0.05 })),
            h(Field, { text: "词面最低分（0–1）" }, numInput(recall.lexicalMinScore, (v) => setConfigValue("recall.lexicalMinScore", v), { min: 0, max: 1, step: 0.05 })),
            h(Field, { text: "相关度下限（0–1）" }, numInput(recall.minRelevance, (v) => setConfigValue("recall.minRelevance", v), { min: 0, max: 1, step: 0.05 })),
            h(Field, { text: "超时（毫秒）", hint: "超时就用词面兜底" }, numInput(recall.timeoutMs, (v) => setConfigValue("recall.timeoutMs", v), { min: 100, max: 5000, step: 50 })),
            h(Field, { text: "注入上限（字）" }, numInput(recall.maxChars, (v) => setConfigValue("recall.maxChars", v), { min: 200, max: 2000, step: 50 })),
            h(Field, { text: "最短查询（字）" }, numInput(recall.minQueryChars, (v) => setConfigValue("recall.minQueryChars", v), { min: 2, max: 200 })),
            h(Field, { text: "最长查询（字）" }, numInput(recall.maxQueryChars, (v) => setConfigValue("recall.maxQueryChars", v), { min: 100, max: 4000, step: 50 })),
            h(Field, { text: "首轮不召回" }, toggle(recall.skipFirstTurn !== false, (v) => setConfigValue("recall.skipFirstTurn", v), "第一轮跳过")),
            h(Field, { text: "跳过的前缀", hint: "英文逗号分隔" },
              textInput((recall.skipPrefixes || []).join(","), (v) => setConfigValue("recall.skipPrefixes", v.split(",").map((x) => x.trim()).filter(Boolean)), "【空闲】,【开机包】"))),
          h(Section, { title: "向量模型", desc: "留空用默认缓存目录；改完要重启插件。" },
            h(Field, { text: "运行时目录 runtimeDir" }, textInput(embedding.runtimeDir, (v) => setConfigValue("embedding.runtimeDir", v), "留空 = ~/.dsh/cache/onefish/runtime/onnx-embed")),
            h(Field, { text: "模型目录 modelDir" }, textInput(embedding.modelDir, (v) => setConfigValue("embedding.modelDir", v), "留空 = 同上目录下的模型"))),
          h("div", { style: { ...C.paste, marginTop: "12px" } },
            h("button", { style: C.btn, disabled: busy === "config" || !dirty, onClick: saveConfig }, busy === "config" ? "保存中…" : "保存配置"),
            h("button", { style: C.btn2, disabled: !dirty, onClick: resetConfigDraft }, "撤销改动"),
            h("span", { style: C.label }, dirty ? "有未保存的改动" : "已与磁盘一致")),
          warnings.length > 0
            ? h("div", { style: { ...C.card, marginTop: "10px", borderColor: "#c98a1b" } },
              h("div", { style: { fontWeight: 600, marginBottom: "6px", fontSize: "12.5px" } }, "这些字段没按你填的生效"),
              h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
                warnings.map((item, index) => h("div", { key: `${item.path}:${index}`, style: { ...C.warn } },
                  `${item.path}：填 ${String(item.requested)} → 实际 ${String(item.applied ?? "忽略")}（${item.reason}）`))))
            : null);
      }

      // ── 渲染：空闲钟 ────────────────────────────────────────────
      function renderIdle() {
        if (!configDraft?.idleClock) return h(Empty, null, "加载中…");
        const c = configDraft.idleClock;
        const idleMinutes = Math.round(Number(idle?.idleMs || 0) / 60000);
        return h("div", null,
          h("div", { style: { ...C.card, marginBottom: "10px" } },
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" } },
              h("div", null,
                h("div", { style: { fontWeight: 600, marginBottom: "3px" } }, "空闲钟"),
                h("div", { style: C.label }, `已空闲 ${idleMinutes} 分钟 · 会话 ${idle?.active ? "active" : "无"} · ${idle?.enabled ? "已启用" : "已关闭"} · 今日触发 ${idle?.firedToday ?? 0} 次`)),
              toggle(c.enabled === true, (v) => setIdleValue("enabled", v), "启用")),
            h("div", { style: { ...C.hint, marginTop: "6px" } }, "空闲 prompt 是主动开口，不是任务；默认关闭，避免突然打扰。")),
          h(Section, { title: "时间尺度", desc: "空闲越久越可能开口，冷却期管住频率。" },
            h(Field, { text: "最小空闲（分钟）" }, numInput(Math.round(Number(c.minIdleMs || 0) / 60000), (v) => setIdleValue("minIdleMs", Number(v) * 60000), { min: 0, step: 1 })),
            h(Field, { text: "概率尺度（小时）" }, numInput(c.scaleHours, (v) => setIdleValue("scaleHours", v), { min: 0.25, step: 0.25 })),
            h(Field, { text: "曲线形状" }, numInput(c.shape, (v) => setIdleValue("shape", v), { min: 0.25, step: 0.25 })),
            h(Field, { text: "冷却最短（分钟）" }, numInput(Math.round(Number(c.cooldownMinMs || 0) / 60000), (v) => setIdleValue("cooldownMinMs", Number(v) * 60000), { min: 0, step: 1 })),
            h(Field, { text: "冷却最长（分钟）" }, numInput(Math.round(Number(c.cooldownMaxMs || 0) / 60000), (v) => setIdleValue("cooldownMaxMs", Number(v) * 60000), { min: 0, step: 1 })),
            h(Field, { text: "检查间隔（分钟）", hint: "最小 1 分钟" }, numInput(Math.round(Number(c.checkIntervalMs || 60000) / 60000), (v) => setIdleValue("checkIntervalMs", Number(v) * 60000), { min: 1, step: 1 }))),
          h("div", { style: C.paste },
            h("button", { style: C.btn, disabled: busy === "idle", onClick: saveIdle }, busy === "idle" ? "保存中…" : "保存空闲钟配置"),
            h("button", { style: C.btn2, disabled: busy === "idle-preview", onClick: previewIdle }, busy === "idle-preview" ? "读取中…" : "预览 prompt"),
            h("button", { style: C.btn2, disabled: busy === "idle-run", onClick: runIdle }, busy === "idle-run" ? "触发中…" : "立即触发一次")),
          idlePreview
            ? h("pre", { style: { ...C.card, whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: "10px", fontSize: "12px", lineHeight: "18px" } }, idlePreview)
            : h("div", { style: { ...C.hint, marginTop: "8px" } }, "点「预览 prompt」看看真触发时会说什么。"));
      }

      // ── 渲染：会话 ──────────────────────────────────────────────
      function renderSession() {
        if (!sessions) return h(Empty, null, "加载中…");
        const rows = sessions.recent || [];
        const stats = sessions.stats || {};
        return h("div", null,
          h("div", { style: { ...C.card, marginBottom: "10px" } },
            h(Row, { name: "今日", value: stats.currentDay }),
            h(Row, { name: "工作区", value: stats.workspaceTitle }),
            h(Row, { name: "当前会话", value: sessions.active ? `${sessions.active.sessionId}` : "还没有" }),
            h(Row, { name: "开机包", value: sessions.active?.bootPackAt ? "已注入" : "未注入" }),
            h(Row, { name: "待整理", value: stats.pending ?? 0 })),
          h("div", { style: C.paste },
            h("button", { style: C.btn2, disabled: busy === "bootpack", onClick: loadBootPreview }, busy === "bootpack" ? "读取中…" : "预览开机包"),
            h("button", { style: C.btn2, disabled: busy === "session-ensure", onClick: ensureSession }, "新建今日会话"),
            h("input", { style: { ...C.input, width: "150px" }, placeholder: "YYYY-MM-DD", value: consolidateDay, onChange: (e) => setConsolidateDay(e.target.value) }),
            h("button", { style: C.btn2, disabled: busy === "session-consolidate", onClick: consolidate }, "整理指定日期")),
          bootPreview
            ? h("pre", { style: { ...C.card, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "360px", overflow: "auto", marginTop: "10px", fontSize: "12px", lineHeight: "18px" } }, bootPreview)
            : h("div", { style: { ...C.hint, marginTop: "8px" } }, "开机包是每轮注入的开场上下文，看一眼就知道模型开局拿到什么。"),
          h("div", { style: { ...C.label, margin: "12px 0 6px" } }, "最近的日会话"),
          rows.length === 0
            ? h(Empty, null, "还没有日会话。在 DSH 里发一条消息，或点上面的「新建今日会话」。")
            : h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
              rows.map((item) => h("div", { key: `${item.day}:${item.sessionId}`, style: { ...C.card, padding: "8px 10px" } },
                h("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center" } },
                  h("span", { style: { fontSize: "12.5px" } }, `${item.day} · ${item.state || item.status || "—"}`),
                  h("button", { style: C.btn2, disabled: busy === "session-retire", onClick: () => retire(item.sessionId) }, "退役")),
                h("div", { style: { ...C.label, marginTop: "3px", wordBreak: "break-all" } }, item.sessionId),
                h("div", { style: { ...C.label, marginTop: "3px" } },
                  `${item.archivePath ? "档案已写" : "未整理"}${item.consolidatedAt ? ` · ${new Date(item.consolidatedAt).toLocaleString()}` : ""}`)))));
      }

      // ── 渲染：自检 ──────────────────────────────────────────────
      function renderDiagnostics() {
        if (!diagnostics) return h(Empty, null, "还没跑自检。");
        const checks = diagnostics.checks || [];
        const summary = diagnostics.summary || {};
        return h("div", null,
          h("div", { style: { ...C.paste, marginBottom: "10px" } },
            h("button", { style: C.btn2, disabled: busy === "diag", onClick: async () => {
              setBusy("diag"); clearFlash();
              try { await loadDiagnostics(); flash("自检已完成"); } catch (e) { setError(String(e?.message || e)); } finally { setBusy(""); }
            } }, busy === "diag" ? "检查中…" : "重新检查"),
            h("button", { style: C.btn2, disabled: busy === "bootstrap", onClick: runBootstrap }, busy === "bootstrap" ? "处理中…" : "一键初始化"),
            h("span", { style: C.label }, `正常 ${summary.pass ?? 0} · 注意 ${summary.warn ?? 0} · 异常 ${summary.fail ?? 0}`)),
          bootstrapActions.length > 0
            ? h("div", { style: { ...C.card, marginBottom: "10px" } },
              h("div", { style: { fontWeight: 600, marginBottom: "6px", fontSize: "12.5px" } }, "初始化结果"),
              h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
                bootstrapActions.map((item) => {
                  const mark = item.status === "done" ? "已完成" : item.status === "failed" ? "失败" : "跳过";
                  const color = item.status === "done" ? "#2fbf71" : item.status === "failed" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-tertiary)";
                  return h("div", { key: item.id, style: { fontSize: "12px" } },
                    h("span", { style: { color, marginRight: "6px" } }, `[${mark}]`),
                    h("span", { style: { fontWeight: 600 } }, item.title),
                    h("span", { style: { ...C.label, marginLeft: "6px" } }, item.detail || ""),
                    item.hint ? h("div", { style: { ...C.hint, marginLeft: "54px" } }, item.hint) : null);
                })))
            : null,
          h("div", { style: { ...C.card, marginBottom: "10px" } },
            h(Row, { name: "版本", value: diagnostics.version }),
            h(Row, { name: "Node", value: diagnostics.node }),
            h(Row, { name: "平台", value: diagnostics.platform }),
            h(Row, { name: "数据目录", value: diagnostics.home }),
            h(Row, { name: "配置文件", value: diagnostics.configFile })),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
            checks.map((item) => {
              const style = STATUS[item.status] || STATUS.warn;
              return h("div", { key: item.id, style: { ...C.card, padding: "8px 10px" } },
                h("div", { style: { display: "flex", gap: "8px", alignItems: "baseline" } },
                  h("span", { style: { color: style.color, fontSize: "12px", fontWeight: 600, flex: "0 0 auto" } }, `● ${style.text}`),
                  h("span", { style: { fontSize: "12.5px", fontWeight: 600 } }, item.title)),
                h("div", { style: { ...C.label, marginTop: "3px", wordBreak: "break-all" } }, item.detail || "—"),
                item.hint ? h("div", { style: { ...C.hint, marginTop: "3px" } }, item.hint) : null);
            })));
      }

      const tabs = [
        ["overview", "概览"],
        ["persona", "人格"],
        ["memory", "记忆"],
        ["config", "配置"],
        ["idle", "空闲钟"],
        ["session", "会话"],
        ["diag", "自检"],
      ];

      return h("div", { style: { maxWidth: "1020px", margin: "0 auto", color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } },
          h("h3", { style: { margin: 0, fontSize: "18px" } }, "OneFish"),
          h("span", { style: { ...C.label, fontSize: "11px" } }, "Core v0.1.0 · 人格 / 记忆 / 日会话"),
          h("span", { style: { flex: 1 } }),
          h("button", { style: C.btn2, onClick: () => void load(), disabled: !!busy }, "刷新全部")),
        h("div", { style: { display: "flex", gap: "2px", margin: "12px 0", borderBottom: "1px solid var(--dsw-alias-border-l2)", flexWrap: "wrap" } },
          tabs.map(([id, text]) => h("button", {
            key: id,
            onClick: () => {
              setTab(id);
              if (id === "diag") void loadDiagnostics().catch((e) => setError(String(e?.message || e)));
            },
            style: {
              border: "none",
              background: "transparent",
              color: tab === id ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
              padding: "7px 10px",
              cursor: "pointer",
              borderBottom: tab === id ? "2px solid #2f6fed" : "2px solid transparent",
              fontSize: "12.5px",
            },
          }, text))),
        error ? h("div", { style: { ...C.err, marginBottom: "8px" } }, `出错：${error}`) : null,
        notice ? h("div", { style: { ...C.ok, marginBottom: "8px" } }, notice) : null,
        h("div", { style: { marginTop: "12px" } },
          tab === "overview" ? renderOverview()
            : tab === "persona" ? renderPersona()
              : tab === "memory" ? renderMemory()
                : tab === "config" ? renderConfig()
                  : tab === "idle" ? renderIdle()
                    : tab === "session" ? renderSession()
                      : renderDiagnostics()));
    }

    const NAMES = { nav: "OneFish" };

    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "onefish-core", order: 8, label: () => NAMES.nav },
            OneFishCoreSection,
          ),
          "onefish-core: settings section"),
        "onefish-core: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.OneFishCoreSection = OneFishCoreSection;
    return module.exports;
  },
});
