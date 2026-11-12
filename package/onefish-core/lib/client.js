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
      const [newText, setNewText] = useState("");
      const [newTier, setNewTier] = useState("active");
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");

      const load = useCallback(async () => {
        setError("");
        try {
          const [o, p, m, s] = await Promise.all([
            api("/overview"),
            api("/persona"),
            api("/memory?limit=50"),
            api("/sessions"),
          ]);
          setOverview(o);
          setPersona(p);
          setDraft(p.text || "");
          setMemories(m.entries || []);
          setSessions(s);
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

      const tabs = [["overview", "概览"], ["persona", "人格"], ["memory", "记忆"], ["session", "会话"]];

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
            h("div", { style: card }, h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "会话"), row("会话数", overview.session?.conversations || 0), row("消息事件", overview.session?.messages || 0), row("最近会话", overview.currentSession?.key || "—")),
            h("div", { style: card }, h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "记忆层级"), row("core", overview.memory?.core || 0), row("active", overview.memory?.active || 0), row("knowledge", overview.memory?.knowledge || 0))),
          h("div", { style: { marginTop: "12px", fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", lineHeight: "18px" } },
            "这是最小核心：只含记忆/人格/统一会话，不加载 QQ、B站、桌宠。QQ/B站/桌宠后续作为组件接入。"));
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

      function renderSession() {
        if (!sessions) return h("div", { style: label }, "加载中…");
        const rows = sessions.recent || [];
        return h("div", null,
          h("div", { style: { ...label, marginBottom: "8px" } }, `共 ${sessions.stats?.conversations || 0} 个会话，${sessions.stats?.messages || 0} 个消息事件`),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
            rows.length === 0 ? h("div", { style: label }, "还没有 DSH 会话事件；在 DSH 对话窗口聊一句后刷新") : rows.map((item) => h("div", { key: item.key, style: { ...card, padding: "8px 10px" } },
              h("div", { style: { fontSize: "12.5px" } }, item.key),
              h("div", { style: { ...label, marginTop: "3px" } }, `${new Date(item.updatedAt || 0).toLocaleString()} · ${item.messageCount || 0} 个事件 · ${item.lastEventType || "—"}`)))));
      }

      return h("div", { style: { maxWidth: "980px", margin: "0 auto", color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } },
          h("h3", { style: { margin: 0, fontSize: "18px" } }, "OneFish"),
          h("span", { style: { ...label, fontSize: "11px" } }, "Core v0.1.0 · 人格 / 记忆 / 统一会话"),
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
