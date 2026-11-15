/**
 * OneFish Core —— DSH 设置页最小客户端。
 *
 * 只做核心面板：概览 / 人格 / 记忆 / 会话。
 * 使用 DSH 提供的 React，由 settings.section slot 注入。
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

    const card = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "12px 14px", background: "rgba(127,127,127,.03)" };
    const label = { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px" };
    const input = { background: "transparent", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", color: "var(--dsw-alias-label-primary)", fontSize: "12.5px", padding: "6px 8px", fontFamily: "inherit" };
    const btn = { background: "#2f6fed", color: "#fff", border: "none", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "12.5px" };
    const btn2 = { ...btn, background: "transparent", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)" };
    const errStyle = { color: "var(--dsw-alias-state-error-primary)", fontSize: "12px", marginTop: "8px" };
    const okStyle = { color: "#2fbf71", fontSize: "12px", marginTop: "8px" };

    function OneFishCoreSection() {
      const [tab, setTab] = useState("overview");
      const [overview, setOverview] = useState(null);
      const [persona, setPersona] = useState(null);
      const [draft, setDraft] = useState("");
      const [memories, setMemories] = useState([]);
      const [sessions, setSessions] = useState(null);
      const [idle, setIdle] = useState(null);
      const [idleDraft, setIdleDraft] = useState(null);
      const [idlePreview, setIdlePreview] = useState("");
      const [bootPreview, setBootPreview] = useState("");
      const [newText, setNewText] = useState("");
      const [newTier, setNewTier] = useState("active");
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");

      const load = useCallback(async () => {
        setError("");
        try {
          const [o, p, m, s, i] = await Promise.all([
            api("/overview"),
            api("/persona"),
            api("/memory?limit=50"),
            api("/sessions"),
            api("/idle/status"),
          ]);
          setOverview(o);
          setPersona(p);
          setDraft(p.text || "");
          setMemories(m.entries || []);
          setSessions(s);
          setIdle(i);
          setIdleDraft((prev) => prev || i.config || null);
        } catch (e) {
          setError(String(e?.message || e));
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      async function savePersona() {
        setBusy("persona");
        setError("");
        setNotice("");
        try {
          const saved = await api("/persona", { method: "POST", body: JSON.stringify({ text: draft }) });
          setPersona(saved);
          setNotice("人格卡已保存");
          await load();
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function addMemory() {
        if (!newText.trim()) return;
        setBusy("memory");
        setError("");
        setNotice("");
        try {
          await api("/memory", { method: "POST", body: JSON.stringify({ text: newText.trim(), tier: newTier }) });
          setNewText("");
          setNotice("记忆已写入");
          await load();
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function deleteMemory(id) {
        setBusy(id);
        setError("");
        setNotice("");
        try {
          await api("/memory/delete", { method: "POST", body: JSON.stringify({ id }) });
          await load();
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function loadBootPreview() {
        setBusy("bootpack");
        setError("");
        try {
          const data = await api("/session/bootpack");
          setBootPreview(String(data.text || ""));
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      function idleField(key, value, multiplier = 1) {
        setIdleDraft((prev) => ({ ...(prev || {}), [key]: Number(value) * multiplier }));
      }

      async function saveIdle() {
        if (!idleDraft) return;
        setBusy("idle");
        setError("");
        setNotice("");
        try {
          const saved = await api("/idle/config", {
            method: "POST",
            body: JSON.stringify({ idleClock: idleDraft }),
          });
          setIdle(saved);
          setIdleDraft(saved.config || idleDraft);
          setNotice("空闲钟配置已保存，立即生效");
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function previewIdle() {
        setBusy("idle-preview");
        setError("");
        try {
          const data = await api("/idle/preview");
          setIdlePreview(String(data.text || ""));
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      async function runIdle() {
        setBusy("idle-run");
        setError("");
        setNotice("");
        try {
          const data = await api("/idle/run", { method: "POST" });
          setNotice(data.fired ? "空闲 prompt 已触发" : `未触发：${data.reason || "未知原因"}`);
          await load();
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy("");
        }
      }

      const tabs = [["overview", "概览"], ["persona", "人格"], ["memory", "记忆"], ["idle", "空闲钟"], ["session", "会话"]];

      function row(labelText, value) {
        return h("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px", padding: "5px 0", borderBottom: ".5px solid var(--dsw-alias-border-l2)", fontSize: "12px" } },
          h("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, labelText),
          h("span", { style: { textAlign: "right", wordBreak: "break-all" } }, String(value ?? "—")));
      }

      function renderOverview() {
        if (!overview) return h("div", { style: label }, "加载中…");
        return h("div", null,
          h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: "10px" } },
            h("div", { style: card }, h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "核心"), row("数据目录", overview.home), row("人格", overview.persona?.name), row("人格字数", overview.persona?.chars), row("记忆", `${overview.memory?.total || 0} 条`)),
            h("div", { style: card }, h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "会话"), row("今日", overview.session?.currentDay || "—"), row("工作区", overview.session?.workspaceTitle || "—"), row("开机包", overview.session?.bootPackAt ? "已注入" : "未注入"), row("状态", overview.session?.active ? "active" : "未建立")),
            h("div", { style: card }, h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "记忆层级"), row("core", overview.memory?.core || 0), row("active", overview.memory?.active || 0), row("knowledge", overview.memory?.knowledge || 0))),
          h("div", { style: { marginTop: "12px", fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", lineHeight: "18px" } },
            "这是最小核心：只含记忆/人格/日会话，不加载具体频道组件。频道组件后续作为可选组件接入。"));
      }

      function renderPersona() {
        return h("div", null,
          h("div", { style: { ...label, marginBottom: "6px" } }, `当前人格：${persona?.name || "—"} · ${persona?.source || "—"}`),
          h("textarea", {
            value: draft,
            onChange: (e) => setDraft(e.target.value),
            style: { ...input, width: "100%", minHeight: "300px", lineHeight: "19px", resize: "vertical", boxSizing: "border-box" },
          }),
          h("div", { style: { display: "flex", gap: "8px", marginTop: "10px", alignItems: "center" } },
            h("button", { style: btn, disabled: busy === "persona" || !draft.trim(), onClick: savePersona }, busy === "persona" ? "保存中…" : "保存人格卡"),
            h("button", { style: btn2, onClick: () => setDraft(persona?.text || "") }, "撤销改动"),
            h("span", { style: label }, "保存后下一轮对话生效")));
      }

      function renderMemory() {
        return h("div", null,
          h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "10px" } },
            h("input", { style: { ...input, flex: "1 1 320px" }, placeholder: "写一条记忆，例如：主人最近在重构 OneFish 核心", value: newText, onChange: (e) => setNewText(e.target.value) }),
            h("select", { style: input, value: newTier, onChange: (e) => setNewTier(e.target.value) },
              h("option", { value: "active" }, "active"),
              h("option", { value: "core" }, "core"),
              h("option", { value: "knowledge" }, "knowledge")),
            h("button", { style: btn, disabled: busy === "memory" || !newText.trim(), onClick: addMemory }, "写入")),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
            memories.length === 0 ? h("div", { style: label }, "没有记忆") : memories.map((item) => h("div", { key: item.id, style: { ...card, padding: "8px 10px" } },
              h("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px" } },
                h("div", null,
                  h("span", { style: { fontSize: "10.5px", color: "var(--dsw-alias-label-tertiary)", marginRight: "6px" } }, `${item.tier}/${item.kind}`),
                  h("span", { style: { fontSize: "12.5px" } }, item.text)),
                h("button", { style: { ...btn2, padding: "2px 8px" }, disabled: busy === item.id, onClick: () => deleteMemory(item.id) }, "删除"))))));
      }

      function renderIdle() {
        if (!idleDraft) return h("div", { style: label }, "加载中…");
        const c = idleDraft;
        const field = (text, key, opts = {}) => h("label", { style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" } },
          h("span", { style: label }, text),
          h("input", {
            ...input,
            type: "number",
            min: opts.min ?? 0,
            step: opts.step ?? 1,
            value: opts.minutes ? Math.round(Number(c[key] || 0) / 60000) : (c[key] ?? 0),
            onChange: (e) => idleField(key, e.target.value, opts.minutes ? 60000 : 1),
          }));
        const idleMinutes = Math.round(Number(idle?.idleMs || 0) / 60000);
        return h("div", null,
          h("div", { style: { ...card, marginBottom: "10px" } },
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" } },
              h("div", null,
                h("div", { style: { fontWeight: 600, marginBottom: "3px" } }, "空闲钟"),
                h("div", { style: label }, `当前已空闲 ${idleMinutes} 分钟 · 会话 ${idle?.active ? "active" : "无"} · ${idle?.enabled ? "已启用" : "已关闭"}`)),
              h("label", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12.5px" } },
                h("input", { type: "checkbox", checked: c.enabled === true, onChange: (e) => setIdleDraft({ ...c, enabled: e.target.checked }) }),
                "启用")),
            h("div", { style: { ...label, marginTop: "6px" } }, "空闲时钟是主动 prompt，不是任务；默认关闭，避免突然打扰。")),
          h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: "10px" } },
            field("最小空闲（分钟）", "minIdleMs", { minutes: true, min: 0, step: 1 }),
            field("概率尺度（小时）", "scaleHours", { min: 0.25, step: 0.25 }),
            field("曲线形状", "shape", { min: 0.25, step: 0.25 }),
            field("冷却最短（分钟）", "cooldownMinMs", { minutes: true, min: 0, step: 1 }),
            field("冷却最长（分钟）", "cooldownMaxMs", { minutes: true, min: 0, step: 1 }),
            field("检查间隔（分钟）", "checkIntervalMs", { minutes: true, min: 1, step: 1 })),
          h("div", { style: { display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" } },
            h("button", { style: btn, disabled: busy === "idle", onClick: saveIdle }, busy === "idle" ? "保存中…" : "保存空闲钟配置"),
            h("button", { style: btn2, disabled: busy === "idle-preview", onClick: previewIdle }, busy === "idle-preview" ? "读取中…" : "预览 prompt"),
            h("button", { style: btn2, disabled: busy === "idle-run", onClick: runIdle }, busy === "idle-run" ? "触发中…" : "立即触发一次")),
          idlePreview ? h("pre", { style: { ...card, whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: "10px", fontSize: "12px", lineHeight: "18px" } }, idlePreview) : null);
      }

      function renderSession() {
        if (!sessions) return h("div", { style: label }, "加载中…");
        const rows = sessions.recent || [];
        const stats = sessions.stats || {};
        const statusText = sessions.active ? `active · ${sessions.active.sessionId}` : "今天还没有日会话";
        const bootText = sessions.active?.bootPackAt ? "开机包已注入" : "开机包未注入";
        return h("div", null,
          h("div", { style: { ...label, marginBottom: "8px" } }, `今日 ${stats.currentDay || "—"} · 工作区 ${stats.workspaceTitle || "—"} · ${statusText} · ${bootText} · 待整理 ${stats.pending || 0}`),
          h("div", { style: { display: "flex", gap: "8px", marginBottom: "8px" } },
            h("button", { style: btn2, onClick: loadBootPreview, disabled: busy === "bootpack" }, busy === "bootpack" ? "读取中…" : "预览开机包")),
          bootPreview ? h("pre", { style: { ...card, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "420px", overflow: "auto", fontSize: "12px", lineHeight: "18px" } }, bootPreview) : null,
          h("div", { style: { ...label, marginBottom: "8px" } }, `DSH 会隐藏空白会话；去「${stats.workspaceTitle || "onefish"}」工作区点“新建对话”即可复用今天的日会话。`),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
            rows.length === 0 ? h("div", { style: label }, "还没有日会话；DSH 对话窗口聊一句或重启插件后会自动建立") : rows.map((item) => h("div", { key: `${item.day}:${item.sessionId}`, style: { ...card, padding: "8px 10px" } },
              h("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px" } },
                h("span", { style: { fontSize: "12.5px" } }, `${item.day} · ${item.state || item.status || "—"}`),
                h("span", { style: { ...label, fontSize: "11px" } }, item.sessionId)),
              h("div", { style: { ...label, marginTop: "3px" } }, `${item.archivePath ? "档案已写" : "未整理"}${item.consolidatedAt ? ` · ${new Date(item.consolidatedAt).toLocaleString()}` : ""}`)))));
      }

      return h("div", { style: { maxWidth: "980px", margin: "0 auto", color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } },
          h("h3", { style: { margin: 0, fontSize: "18px" } }, "OneFish"),
          h("span", { style: { ...label, fontSize: "11px" } }, "Core v0.1.0 · 人格 / 记忆 / 日会话"),
          h("span", { style: { flex: 1 } }),
          h("button", { style: btn2, onClick: () => void load(), disabled: !!busy }, "刷新")),
        h("div", { style: { display: "flex", gap: "2px", margin: "12px 0", borderBottom: "1px solid var(--dsw-alias-border-l2)" } },
          tabs.map(([id, labelText]) => h("button", {
            key: id,
            onClick: () => setTab(id),
            style: { border: "none", background: "transparent", color: tab === id ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)", padding: "7px 10px", cursor: "pointer", borderBottom: tab === id ? "2px solid #2f6fed" : "2px solid transparent", fontSize: "12.5px" },
          }, labelText))),
        error ? h("div", { style: errStyle }, error) : null,
        notice ? h("div", { style: okStyle }, notice) : null,
        h("div", { style: { marginTop: "12px" } },
          tab === "overview" ? renderOverview()
            : tab === "persona" ? renderPersona()
              : tab === "memory" ? renderMemory()
                : tab === "idle" ? renderIdle()
                  : renderSession()));
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
