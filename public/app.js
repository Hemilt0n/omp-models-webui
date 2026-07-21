(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const elements = {
    configPath: $("config-path"),
    reloadButton: $("reload-button"),
    newButton: $("new-button"),
    providerList: $("provider-list"),
    emptyState: $("empty-state"),
    editorMode: $("editor-mode"),
    editorTitle: $("editor-title"),
    credentialBadge: $("credential-badge"),
    pageError: $("page-error"),
    pageStatus: $("page-status"),
    form: $("provider-form"),
    providerId: $("provider-id"),
    baseUrl: $("base-url"),
    apiKey: $("api-key"),
    apiType: $("api-type"),
    discoveryType: $("discovery-type"),
    authHeader: $("auth-header"),
    disableStrictTools: $("disable-strict-tools"),
    headersJson: $("headers-json"),
    headersError: $("headers-error"),
    modelsJson: $("models-json"),
    modelsError: $("models-error"),
    saveButton: $("save-button"),
    deleteButton: $("delete-button"),
    discoverButton: $("discover-button"),
    probeButton: $("probe-button"),
    runInference: $("run-inference"),
    inferenceModel: $("inference-model"),
    modelOptions: $("discovered-model-options"),
    probeError: $("probe-error"),
    probeSummary: $("probe-summary"),
    checkList: $("check-list"),
    modelsResult: $("models-result"),
    modelCount: $("model-count"),
    modelList: $("model-list"),
    discoverySource: $("discovery-source"),
    discoveryWarning: $("discovery-warning"),
    modelSearch: $("model-search"),
    selectAllModels: $("select-all-models"),
    selectNoModels: $("select-no-models"),
    syncModelsButton: $("sync-models-button"),
    addModelButton: $("add-model-button"),
    modelEditorDialog: $("model-editor-dialog"),
    modelEditorForm: $("model-editor-form"),
    modelEditorTitle: $("model-editor-title"),
    modelEditorClose: $("model-editor-close"),
    modelEditorCancel: $("model-editor-cancel"),
    modelEditorError: $("model-editor-error"),
    modelId: $("model-id"),
    modelName: $("model-name"),
    modelApi: $("model-api"),
    modelBaseUrl: $("model-base-url"),
    modelContextWindow: $("model-context-window"),
    modelMaxTokens: $("model-max-tokens"),
    modelReasoning: $("model-reasoning"),
    modelSupportsTools: $("model-supports-tools"),
    modelThinkingMode: $("model-thinking-mode"),
    modelThinkingEfforts: $("model-thinking-efforts"),
    modelDefaultEffort: $("model-default-effort"),
    modelEffortMap: $("model-effort-map"),
    modelJson: $("model-json"),
    modelEditorSave: $("model-editor-save"),
  };

  const SUPPORTED_PROBE_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

  const state = {
    revision: "",
    providers: [],
    selectedId: null,
    originalDefinition: {},
    dirty: false,
    loading: false,
    formBusy: false,
    probeBusy: false,
    modelEntries: [],
    editingModelId: null,
  };

  const checkMetadata = [
    { id: "endpoint", label: "Endpoint" },
    { id: "authentication", label: "认证" },
    { id: "discovery", label: "模型发现" },
    { id: "inference", label: "推理检测" },
  ];

  function setAlert(element, message) {
    element.textContent = message || "";
    element.hidden = !message;
  }

  function clearPageMessages() {
    setAlert(elements.pageError, "");
    setAlert(elements.pageStatus, "");
  }

  function errorMessage(error, fallback) {
    if (error instanceof Error && error.message) return error.message;
    return fallback;
  }

  async function request(url, options = {}) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (_error) {
      throw new Error("无法连接本地服务，请确认服务仍在运行。");
    }

    const contentType = response.headers.get("content-type") || "";
    let payload;
    if (contentType.includes("application/json")) {
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
    } else {
      const text = await response.text();
      payload = text ? { error: text } : null;
    }

    if (!response.ok) {
      const prefix = response.status === 409 ? "配置已被其他进程修改（409）。请刷新后重试。" : `请求失败（${response.status}）。`;
      const detail = payload && typeof payload.error === "string" ? payload.error : "";
      throw new Error(detail ? `${prefix} ${detail}` : prefix);
    }

    if (payload === null || payload === undefined) {
      throw new Error("服务返回了无法读取的响应。");
    }
    return payload;
  }

  function hasCredential(credential) {
    if (typeof credential === "boolean") return credential;
    if (typeof credential === "string") {
      return !["", "none", "missing", "unset", "not-configured"].includes(credential.toLowerCase());
    }
    if (credential && typeof credential === "object") {
      if (typeof credential.configured === "boolean") return credential.configured;
      if (typeof credential.hasApiKey === "boolean") return credential.hasApiKey;
      return true;
    }
    return false;
  }

  function providerById(id) {
    return state.providers.find((provider) => provider.id === id) || null;
  }

  function renderProviderList() {
    const fragment = document.createDocumentFragment();
    for (const provider of state.providers) {
      const item = document.createElement("div");
      item.setAttribute("role", "listitem");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider-item";
      button.disabled = state.formBusy;
      button.dataset.providerId = provider.id;
      button.setAttribute("aria-current", String(provider.id === state.selectedId));

      const name = document.createElement("strong");
      name.textContent = provider.id;
      const meta = document.createElement("span");
      const url = provider.definition && typeof provider.definition.baseUrl === "string" ? provider.definition.baseUrl : "未设置 Base URL";
      meta.textContent = `${url}${hasCredential(provider.credential) ? " · 已配置密钥" : ""}`;

      button.append(name, meta);
      button.addEventListener("click", () => selectProvider(provider.id));
      item.append(button);
      fragment.append(item);
    }
    elements.providerList.replaceChildren(fragment);
    elements.providerList.setAttribute("aria-busy", "false");
    elements.emptyState.hidden = state.providers.length !== 0;
  }

  function formatJson(value, fallback) {
    try {
      return JSON.stringify(value === undefined ? fallback : value, null, 2);
    } catch (_error) {
      return JSON.stringify(fallback, null, 2);
    }
  }

  function setApiValue(value) {
    const previousExistingOption = elements.apiType.querySelector("option[data-existing-api]");
    if (previousExistingOption) previousExistingOption.remove();

    const api = typeof value === "string" && value ? value : "openai-completions";
    const hasOption = Array.from(elements.apiType.options).some((option) => option.value === api);
    if (!hasOption) {
      const option = document.createElement("option");
      option.value = api;
      option.textContent = `${api}（现有值）`;
      option.dataset.existingApi = "true";
      elements.apiType.append(option);
    }
    elements.apiType.value = api;
  }

  function resetProbeResults() {
    setAlert(elements.probeError, "");
    setAlert(elements.discoveryWarning, "");
    elements.probeSummary.textContent = "尚未运行自检。";
    elements.checkList.replaceChildren();
    elements.modelList.replaceChildren();
    elements.modelOptions.replaceChildren();
    elements.discoverySource.textContent = "";
    elements.modelSearch.value = "";
    elements.modelCount.textContent = "";
    elements.modelsResult.hidden = true;
    state.modelEntries = [];
  }

  function fillForm(provider) {
    const editing = Boolean(provider);
    const definition = editing && provider.definition && typeof provider.definition === "object" ? provider.definition : {};
    state.selectedId = editing ? provider.id : null;
    state.originalDefinition = structuredClone(definition);

    elements.editorMode.textContent = editing ? "EDIT PROVIDER" : "NEW PROVIDER";
    elements.editorTitle.textContent = editing ? provider.id : "新建 Provider";
    elements.providerId.value = editing ? provider.id : "";
    elements.providerId.readOnly = editing;
    elements.baseUrl.value = typeof definition.baseUrl === "string" ? definition.baseUrl : "";
    elements.apiKey.value = "";
    elements.apiKey.placeholder = editing ? "留空则保留当前密钥" : "输入 API Key（如服务需要）";
    setApiValue(definition.api);
    elements.discoveryType.value = definition.discovery && typeof definition.discovery.type === "string" ? definition.discovery.type : editing ? "" : "openai-models-list";
    elements.authHeader.checked = definition.authHeader === true;
    elements.disableStrictTools.checked = definition.disableStrictTools === true;
    elements.headersJson.value = formatJson(definition.headers, {});
    elements.modelsJson.value = formatJson(definition.models, []);
    elements.headersJson.removeAttribute("aria-invalid");
    elements.modelsJson.removeAttribute("aria-invalid");
    elements.headersError.textContent = "";
    elements.modelsError.textContent = "";
    elements.deleteButton.hidden = !editing;
    elements.credentialBadge.hidden = !editing || !hasCredential(provider.credential);
    elements.runInference.checked = false;
    elements.inferenceModel.value = "";
    elements.inferenceModel.disabled = true;
    state.dirty = false;
    clearPageMessages();
    resetProbeResults();
    if (editing && Array.isArray(definition.models) && definition.models.length > 0) {
      renderDiscoveryResult({ models: definition.models, source: "configured-initial" }, definition.models);
    }
    renderProviderList();
  }

  function confirmDiscard() {
    return !state.dirty || window.confirm("当前修改尚未保存，确定要放弃吗？");
  }

  function selectProvider(id) {
    if (id === state.selectedId) return;
    if (!confirmDiscard()) return;
    const provider = providerById(id);
    if (provider) fillForm(provider);
  }

  function startNew() {
    if (!confirmDiscard()) return;
    fillForm(null);
    elements.providerId.focus();
  }

  async function loadProviders(preferredId = state.selectedId, announce = false) {
    if (state.loading) return;
    state.loading = true;
    elements.reloadButton.disabled = true;
    elements.providerList.setAttribute("aria-busy", "true");
    clearPageMessages();

    try {
      const data = await request("/api/providers");
      state.revision = data.revision;
      state.providers = Array.isArray(data.providers) ? data.providers : [];
      elements.configPath.textContent = typeof data.path === "string" ? data.path : "路径不可用";
      elements.configPath.title = elements.configPath.textContent;

      const selected = preferredId ? providerById(preferredId) : null;
      if (selected) {
        fillForm(selected);
      } else if (state.providers.length > 0 && state.selectedId !== null) {
        fillForm(state.providers[0]);
      } else {
        fillForm(null);
      }
      if (announce) setAlert(elements.pageStatus, "配置已刷新。");
    } catch (error) {
      setAlert(elements.pageError, errorMessage(error, "读取配置失败。"));
      elements.providerList.setAttribute("aria-busy", "false");
    } finally {
      state.loading = false;
      elements.reloadButton.disabled = false;
    }
  }

  function parseJsonField(element, errorElement, label) {
    try {
      const parsed = JSON.parse(element.value);
      element.removeAttribute("aria-invalid");
      errorElement.textContent = "";
      return { ok: true, value: parsed };
    } catch (error) {
      element.setAttribute("aria-invalid", "true");
      errorElement.textContent = `${label} 不是有效 JSON：${errorMessage(error, "格式错误")}`;
      return { ok: false };
    }
  }

  function validateHeaders(headers) {
    if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
      elements.headersJson.setAttribute("aria-invalid", "true");
      elements.headersError.textContent = "headers 必须是 JSON 对象。";
      return false;
    }
    const invalid = Object.entries(headers).find(([, value]) => typeof value !== "string");
    if (invalid) {
      elements.headersJson.setAttribute("aria-invalid", "true");
      elements.headersError.textContent = `header“${invalid[0]}”的值必须是字符串。`;
      return false;
    }
    elements.headersJson.removeAttribute("aria-invalid");
    elements.headersError.textContent = "";
    return true;
  }

  function validateModels(models) {
    if (!Array.isArray(models)) {
      elements.modelsJson.setAttribute("aria-invalid", "true");
      elements.modelsError.textContent = "models 必须是 JSON 数组。";
      return false;
    }
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      if (model === null || typeof model !== "object" || Array.isArray(model)) {
        elements.modelsJson.setAttribute("aria-invalid", "true");
        elements.modelsError.textContent = `models[${index}] 必须是对象。`;
        return false;
      }
      if (typeof model.id !== "string" || !model.id.trim()) {
        elements.modelsJson.setAttribute("aria-invalid", "true");
        elements.modelsError.textContent = `models[${index}].id 必须是非空字符串。`;
        return false;
      }
      for (const field of ["contextWindow", "maxTokens"]) {
        if (
          model[field] !== undefined &&
          (typeof model[field] !== "number" || !Number.isFinite(model[field]) || model[field] <= 0)
        ) {
          elements.modelsJson.setAttribute("aria-invalid", "true");
          elements.modelsError.textContent = `models[${index}].${field} 必须是正数。`;
          return false;
        }
      }
    }
    elements.modelsJson.removeAttribute("aria-invalid");
    elements.modelsError.textContent = "";
    return true;
  }

  function buildDefinition(modelsOverride) {
    const headers = parseJsonField(elements.headersJson, elements.headersError, "headers");
    const models =
      modelsOverride === undefined
        ? parseJsonField(elements.modelsJson, elements.modelsError, "models")
        : { ok: true, value: modelsOverride };
    if (!headers.ok || !models.ok) return null;
    const headersValid = validateHeaders(headers.value);
    const modelsValid = validateModels(models.value);
    if (!headersValid || !modelsValid) return null;

    const definition = structuredClone(state.originalDefinition);
    definition.baseUrl = elements.baseUrl.value.trim();
    definition.api = elements.apiType.value;
    definition.disableStrictTools = elements.disableStrictTools.checked;
    definition.headers = headers.value;
    definition.models = models.value;

    if (elements.authHeader.checked) definition.authHeader = true;
    else delete definition.authHeader;

    const discoveryType = elements.discoveryType.value.trim();
    if (discoveryType) {
      const discovery = definition.discovery && typeof definition.discovery === "object" && !Array.isArray(definition.discovery) ? definition.discovery : {};
      definition.discovery = { ...discovery, type: discoveryType };
    } else if (definition.discovery && typeof definition.discovery === "object" && !Array.isArray(definition.discovery)) {
      const discovery = { ...definition.discovery };
      delete discovery.type;
      if (Object.keys(discovery).length === 0) delete definition.discovery;
      else definition.discovery = discovery;
    }

    return definition;
  }

  function setFormBusy(busy) {
    state.formBusy = busy;
    for (const control of document.querySelectorAll("button, input, select, textarea")) {
      control.disabled = busy;
    }
    if (!busy) {
      elements.reloadButton.disabled = state.loading;
      elements.discoverButton.disabled = state.probeBusy;
      elements.probeButton.disabled = state.probeBusy;
      elements.inferenceModel.disabled = !elements.runInference.checked;
      updateModelControls();
    }
  }

  async function saveProvider(event) {
    event.preventDefault();
    clearPageMessages();
    if (!elements.form.reportValidity()) return;

    const id = elements.providerId.value.trim();
    if (!id) {
      elements.providerId.setCustomValidity("请输入 Provider ID。");
      elements.providerId.reportValidity();
      return;
    }
    elements.providerId.setCustomValidity("");

    const definition = buildDefinition();
    if (!definition) return;
    if (!state.selectedId && definition.models.length === 0 && !definition.discovery?.type) {
      setAlert(elements.pageError, "新 Provider 必须配置模型列表或 discovery.type。");
      elements.discoveryType.focus();
      return;
    }

    const body = { revision: state.revision, definition };
    const apiKey = elements.apiKey.value;
    if (apiKey) body.apiKey = apiKey;

    setFormBusy(true);
    elements.saveButton.textContent = "正在保存…";
    try {
      await request(`/api/providers/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      state.dirty = false;
      await loadProviders(id);
      setAlert(elements.pageStatus, "配置已保存。API Key 不会在页面中回显。");
    } catch (error) {
      setAlert(elements.pageError, errorMessage(error, "保存失败。"));
    } finally {
      setFormBusy(false);
      elements.saveButton.textContent = "保存配置";
    }
  }

  async function deleteProvider() {
    const id = state.selectedId;
    if (!id) return;
    if (!window.confirm(`确定删除 Provider“${id}”吗？此操作无法撤销。`)) return;

    clearPageMessages();
    setFormBusy(true);
    elements.deleteButton.textContent = "正在删除…";
    try {
      await request(`/api/providers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: state.revision }),
      });
      state.dirty = false;
      state.selectedId = null;
      await loadProviders(null);
      setAlert(elements.pageStatus, `Provider“${id}”已删除。`);
    } catch (error) {
      setAlert(elements.pageError, errorMessage(error, "删除失败。"));
    } finally {
      setFormBusy(false);
      elements.deleteButton.textContent = "删除";
    }
  }

  function normalizeModels(models) {
    if (!Array.isArray(models)) return [];
    const values = [];
    for (const model of models) {
      if (typeof model === "string") values.push(model);
      else if (model && typeof model.id === "string") values.push(model.id);
      else if (model && typeof model.name === "string") values.push(model.name);
      else if (model !== null && model !== undefined) {
        try {
          values.push(JSON.stringify(model));
        } catch (_error) {
          // Ignore values that cannot be represented safely in the UI.
        }
      }
    }
    return [...new Set(values)];
  }
  const SAFE_MODEL_FIELDS = [
    "id",
    "name",
    "api",
    "baseUrl",
    "contextWindow",
    "maxTokens",
    "reasoning",
    "thinking",
    "input",
    "supportsTools",
    "omitMaxOutputTokens",
    "premiumMultiplier",
    "cost",
    "compat",
    "contextPromotionTarget",
    "compactionModel",
    "remoteCompaction",
    "headers",
  ];

  function sanitizeDiscoveredModel(model) {
    if (!model || typeof model !== "object" || Array.isArray(model) || typeof model.id !== "string" || !model.id.trim()) {
      return null;
    }
    const safe = {};
    for (const field of SAFE_MODEL_FIELDS) {
      if (model[field] !== undefined) safe[field] = structuredClone(model[field]);
    }
    safe.id = model.id.trim();
    return safe;
  }

  function modelForEntry(entry) {
    if (entry.custom) return entry.custom;
    if (entry.existing && entry.discovered) {
      const merged = { ...entry.discovered, ...entry.existing, id: entry.id };
      if (entry.discovered.compat || entry.existing.compat) {
        merged.compat = { ...entry.discovered.compat, ...entry.existing.compat };
      }
      return merged;
    }
    return entry.existing || entry.discovered;
  }

  function setModelOptions(modelIds) {
    const fragment = document.createDocumentFragment();
    for (const id of [...new Set(modelIds)]) {
      const option = document.createElement("option");
      option.value = id;
      fragment.append(option);
    }
    elements.modelOptions.replaceChildren(fragment);
  }

  function discoverySourceLabel(source) {
    if (source === "remote") return "来源：远程端点";
    if (source === "omp-registry") return "来源：OMP Registry（远程发现失败，已回退）";
    if (source === "configured") return "来源：当前 models.yml（远程发现失败，已回退）";
    if (source === "configured-initial") return "来源：当前 models.yml";
    if (source === "manual") return "来源：手动配置";
    return "来源：未知（非远程结果）";
  }

  function updateModelControls() {
    const locked = state.formBusy || state.probeBusy;
    const hasModels = state.modelEntries.length > 0;
    elements.modelSearch.disabled = locked || !hasModels;
    elements.selectAllModels.disabled = locked || !hasModels;
    elements.selectNoModels.disabled = locked || !hasModels;
    elements.syncModelsButton.disabled = locked || elements.modelsResult.hidden;
    for (const checkbox of elements.modelList.querySelectorAll('input[type="checkbox"]')) {
      checkbox.disabled = locked;
    }
    for (const button of elements.modelList.querySelectorAll(".model-configure-button")) {
      const entry = state.modelEntries.find((candidate) => candidate.id === button.dataset.modelId);
      button.disabled = locked || !entry?.selected;
    }
  }

  function renderModelSelection() {
    const query = elements.modelSearch.value.trim().toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    let visible = 0;

    for (const entry of state.modelEntries) {
      const model = modelForEntry(entry);
      const name = model && typeof model.name === "string" ? model.name : "";
      if (query && !entry.id.toLocaleLowerCase().includes(query) && !name.toLocaleLowerCase().includes(query)) continue;
      visible += 1;

      const item = document.createElement("li");
      const label = document.createElement("label");
      label.className = "model-checkbox-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = entry.selected;
      checkbox.disabled = state.formBusy || state.probeBusy;
      checkbox.addEventListener("change", () => {
        entry.selected = checkbox.checked;
        renderModelCount();
        renderModelSelection();
      });

      const text = document.createElement("span");
      text.className = "model-checkbox-text";
      const id = document.createElement("strong");
      id.textContent = entry.id;
      id.title = entry.id;
      text.append(id);
      if (name && name !== entry.id) {
        const modelName = document.createElement("span");
        modelName.textContent = name;
        text.append(modelName);
      }

      label.append(checkbox, text);
      item.append(label);
      if (model.api) {
        const apiBadge = document.createElement("span");
        apiBadge.className = "model-api-badge";
        apiBadge.textContent = model.api;
        apiBadge.title = model.baseUrl ? `${model.api} · ${model.baseUrl}` : model.api;
        item.append(apiBadge);
      }
      if (entry.existing && !entry.discovered) {
        const badge = document.createElement("span");
        badge.className = "configured-model-badge";
        badge.textContent = "当前配置 · 发现结果未包含";
        item.append(badge);
      }
      const configureButton = document.createElement("button");
      configureButton.className = "button secondary compact model-configure-button";
      configureButton.dataset.modelId = entry.id;
      configureButton.type = "button";
      configureButton.textContent = "配置";
      configureButton.disabled = !entry.selected || state.formBusy || state.probeBusy;
      configureButton.addEventListener("click", () => openModelEditor(entry));
      item.append(configureButton);
      fragment.append(item);
    }

    if (visible === 0) {
      const empty = document.createElement("li");
      empty.className = "model-list-empty";
      empty.textContent = state.modelEntries.length === 0 ? "没有可选择的模型。" : "没有匹配的模型。";
      fragment.append(empty);
    }

    elements.modelList.replaceChildren(fragment);
    updateModelControls();
  }

  function renderModelCount() {
    const selected = state.modelEntries.filter((entry) => entry.selected).length;
    elements.modelCount.textContent = `已选 ${selected} / 共 ${state.modelEntries.length}`;
  }

  function showModelDirectory(source = "manual") {
    elements.modelsResult.hidden = false;
    elements.discoverySource.textContent = discoverySourceLabel(source);
    setModelOptions(state.modelEntries.map((entry) => entry.id));
    renderModelCount();
    renderModelSelection();
  }

  function renderDiscoveryResult(result, currentModels) {
    const existingById = new Map(currentModels.map((model) => [model.id, structuredClone(model)]));
    const previousById = new Map(state.modelEntries.map((entry) => [entry.id, entry]));
    const discovered = [];
    const discoveredIds = new Set();
    for (const value of Array.isArray(result.models) ? result.models : []) {
      const model = sanitizeDiscoveredModel(value);
      if (!model || discoveredIds.has(model.id)) continue;
      discoveredIds.add(model.id);
      discovered.push(model);
    }

    const hasCurrentModels = currentModels.length > 0;
    state.modelEntries = discovered.map((model) => {
      const previous = previousById.get(model.id);
      return {
        id: model.id,
        discovered: model,
        existing: existingById.get(model.id) || previous?.existing || null,
        custom: previous?.custom || null,
        selected: previous ? previous.selected : hasCurrentModels ? existingById.has(model.id) : true,
      };
    });
    for (const model of currentModels) {
      if (discoveredIds.has(model.id)) continue;
      const previous = previousById.get(model.id);
      state.modelEntries.push({
        id: model.id,
        discovered: null,
        existing: structuredClone(model),
        custom: previous?.custom || null,
        selected: previous ? previous.selected : true,
      });
    }

    const knownIds = new Set(state.modelEntries.map((entry) => entry.id));
    for (const previous of previousById.values()) {
      if (knownIds.has(previous.id)) continue;
      state.modelEntries.push(previous);
    }

    elements.modelSearch.value = "";
    elements.discoverySource.textContent = discoverySourceLabel(result.source);
    setAlert(elements.discoveryWarning, typeof result.warning === "string" ? result.warning : "");
    elements.modelsResult.hidden = false;
    setModelOptions(state.modelEntries.map((entry) => entry.id));
    renderModelCount();
    renderModelSelection();
  }


  function renderProbeResult(result) {
    const checks = Array.isArray(result.checks) ? result.checks : [];
    const byId = new Map(checks.map((check) => [check.id, check]));
    const fragment = document.createDocumentFragment();

    for (const metadata of checkMetadata) {
      const check = byId.get(metadata.id) || {
        id: metadata.id,
        label: metadata.label,
        status: "skip",
        detail: "服务未返回此项结果。",
      };
      const status = ["pass", "fail", "skip"].includes(check.status) ? check.status : "skip";
      const card = document.createElement("article");
      card.className = `check-card ${status}`;

      const head = document.createElement("div");
      head.className = "check-card-head";
      const title = document.createElement("h3");
      title.textContent = check.label || metadata.label;
      const badge = document.createElement("span");
      badge.className = `status-badge ${status}`;
      badge.textContent = status === "pass" ? "通过" : status === "fail" ? "失败" : "跳过";
      head.append(title, badge);

      const detail = document.createElement("p");
      const latency = Number.isFinite(check.latencyMs) ? ` · ${Math.round(check.latencyMs)} ms` : "";
      detail.textContent = `${check.detail || "无详细信息"}${latency}`;
      card.append(head, detail);
      fragment.append(card);
    }
    elements.checkList.replaceChildren(fragment);

    const models = normalizeModels(result.models);
    const discoveredIds = state.modelEntries.map((entry) => entry.id);
    setModelOptions([...discoveredIds, ...models]);

    const failed = checks.filter((check) => check.status === "fail").length;
    const passed = checks.filter((check) => check.status === "pass").length;
    const duration = Number.isFinite(result.durationMs) ? `，耗时 ${Math.round(result.durationMs)} ms` : "";
    const detected = result.detectedApi ? `，检测到 ${result.detectedApi}` : "";
    elements.probeSummary.textContent = `自检完成：${passed} 项通过，${failed} 项失败${duration}${detected}。`;
  }

  const THINKING_LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const THINKING_LEVELS = new Set(THINKING_LEVEL_ORDER);

  function closeModelEditor() {
    state.editingModelId = null;
    setAlert(elements.modelEditorError, "");
    elements.modelEditorDialog.close();
  }

  function openModelEditor(entry = null) {
    const model = entry
      ? structuredClone(modelForEntry(entry))
      : {
          id: "",
          name: "",
          contextWindow: 128000,
          maxTokens: 8192,
          reasoning: false,
          input: ["text"],
        };
    const thinking = model.thinking && typeof model.thinking === "object" && !Array.isArray(model.thinking)
      ? model.thinking
      : {};

    state.editingModelId = entry?.id || null;
    elements.modelEditorTitle.textContent = entry ? `配置 ${entry.id}` : "手动添加模型";
    elements.modelId.value = model.id || "";
    elements.modelId.readOnly = Boolean(entry);
    elements.modelName.value = typeof model.name === "string" ? model.name : "";
    elements.modelApi.value = typeof model.api === "string" ? model.api : "";
    elements.modelBaseUrl.value = typeof model.baseUrl === "string" ? model.baseUrl : "";
    elements.modelContextWindow.value = Number.isFinite(model.contextWindow) ? String(model.contextWindow) : "";
    elements.modelMaxTokens.value = Number.isFinite(model.maxTokens) ? String(model.maxTokens) : "";
    elements.modelReasoning.checked = model.reasoning === true;
    elements.modelSupportsTools.checked = model.supportsTools === true;
    elements.modelSupportsTools.dataset.configured = typeof model.supportsTools === "boolean" ? "true" : "false";
    elements.modelThinkingMode.value = typeof thinking.mode === "string" ? thinking.mode : "";
    let efforts = Array.isArray(thinking.efforts)
      ? thinking.efforts
      : Array.isArray(thinking.levels)
        ? thinking.levels
        : [];
    if (
      efforts.length === 0 &&
      typeof thinking.minLevel === "string" &&
      typeof thinking.maxLevel === "string"
    ) {
      const minimum = THINKING_LEVEL_ORDER.indexOf(thinking.minLevel);
      const maximum = THINKING_LEVEL_ORDER.indexOf(thinking.maxLevel);
      if (minimum >= 0 && maximum >= minimum) {
        efforts = THINKING_LEVEL_ORDER.slice(minimum, maximum + 1);
      }
    }
    elements.modelThinkingEfforts.value = efforts.join(", ");
    elements.modelDefaultEffort.value = typeof thinking.defaultLevel === "string" ? thinking.defaultLevel : "";
    elements.modelEffortMap.value = formatJson(thinking.effortMap, {});
    elements.modelJson.value = formatJson(model, {});
    setAlert(elements.modelEditorError, "");
    elements.modelEditorDialog.showModal();
    elements.modelId.focus();
  }

  function saveModelEditor(event) {
    event.preventDefault();
    setAlert(elements.modelEditorError, "");
    let model;
    let effortMap;
    try {
      model = JSON.parse(elements.modelJson.value);
      effortMap = JSON.parse(elements.modelEffortMap.value || "{}");
    } catch (error) {
      setAlert(elements.modelEditorError, errorMessage(error, "模型 JSON 必须是有效 JSON。"));
      return;
    }
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      setAlert(elements.modelEditorError, "完整模型 JSON 必须是对象。");
      return;
    }
    if (!effortMap || typeof effortMap !== "object" || Array.isArray(effortMap)) {
      setAlert(elements.modelEditorError, "Effort Map 必须是 JSON 对象。");
      return;
    }
    if (Object.values(effortMap).some((value) => typeof value !== "string")) {
      setAlert(elements.modelEditorError, "Effort Map 的值必须都是字符串。");
      return;
    }

    const id = elements.modelId.value.trim();
    if (!id) {
      setAlert(elements.modelEditorError, "模型 ID 不能为空。");
      elements.modelId.focus();
      return;
    }
    const duplicate = state.modelEntries.find((entry) => entry.id === id && entry.id !== state.editingModelId);
    if (duplicate) {
      setAlert(elements.modelEditorError, `模型 ID“${id}”已经存在。`);
      return;
    }

    model.id = id;
    const name = elements.modelName.value.trim();
    if (name) model.name = name;
    else delete model.name;
    const api = elements.modelApi.value;
    if (api) model.api = api;
    else delete model.api;
    const baseUrl = elements.modelBaseUrl.value.trim();
    if (baseUrl) model.baseUrl = baseUrl;
    else delete model.baseUrl;

    for (const [field, element] of [
      ["contextWindow", elements.modelContextWindow],
      ["maxTokens", elements.modelMaxTokens],
    ]) {
      if (!element.value) {
        delete model[field];
        continue;
      }
      const value = Number(element.value);
      if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
        setAlert(elements.modelEditorError, `${field} 必须是正整数。`);
        element.focus();
        return;
      }
      model[field] = value;
    }
    model.reasoning = elements.modelReasoning.checked;
    if (elements.modelSupportsTools.dataset.configured === "true") {
      model.supportsTools = elements.modelSupportsTools.checked;
    } else {
      delete model.supportsTools;
    }

    const thinkingMode = elements.modelThinkingMode.value;
    if (thinkingMode) {
      const efforts = elements.modelThinkingEfforts.value
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (efforts.length === 0 || efforts.some((value) => !THINKING_LEVELS.has(value))) {
        setAlert(elements.modelEditorError, "Efforts 至少包含一个合法级别。");
        elements.modelThinkingEfforts.focus();
        return;
      }
      const thinking = model.thinking && typeof model.thinking === "object" && !Array.isArray(model.thinking)
        ? { ...model.thinking }
        : {};
      thinking.mode = thinkingMode;
      thinking.efforts = [...new Set(efforts)];
      delete thinking.levels;
      delete thinking.minLevel;
      delete thinking.maxLevel;
      const defaultLevel = elements.modelDefaultEffort.value;
      if (defaultLevel) thinking.defaultLevel = defaultLevel;
      else delete thinking.defaultLevel;
      if (Object.keys(effortMap).length > 0) thinking.effortMap = effortMap;
      else delete thinking.effortMap;
      model.thinking = thinking;
    } else {
      delete model.thinking;
    }

    const entry = state.editingModelId
      ? state.modelEntries.find((candidate) => candidate.id === state.editingModelId)
      : null;
    if (entry) {
      entry.custom = structuredClone(model);
      entry.selected = true;
    } else {
      state.modelEntries.push({
        id,
        discovered: null,
        existing: null,
        custom: structuredClone(model),
        selected: true,
      });
    }
    state.dirty = true;
    if (elements.modelsResult.hidden) showModelDirectory("manual");
    else {
      setModelOptions(state.modelEntries.map((candidate) => candidate.id));
      renderModelCount();
      renderModelSelection();
    }
    closeModelEditor();
  }

  function setProbeBusy(busy, source) {
    state.probeBusy = busy;
    elements.discoverButton.disabled = busy || state.formBusy;
    elements.probeButton.disabled = busy || state.formBusy;
    elements.discoverButton.textContent = busy && source === "discover" ? "正在发现…" : "发现模型";
    elements.probeButton.textContent = busy && source === "probe" ? "正在检测…" : "运行自检";
    updateModelControls();
  }

  async function runDiscover() {
    setAlert(elements.probeError, "");
    if (!elements.baseUrl.value.trim()) {
      setAlert(elements.probeError, "请先填写 Base URL。");
      elements.baseUrl.focus();
      return;
    }

    const headers = parseJsonField(elements.headersJson, elements.headersError, "headers");
    const models = parseJsonField(elements.modelsJson, elements.modelsError, "models");
    if (!headers.ok || !validateHeaders(headers.value)) {
      setAlert(elements.probeError, "请先修正 headers JSON。");
      elements.headersJson.focus();
      return;
    }
    if (!models.ok || !validateModels(models.value)) {
      setAlert(elements.probeError, "请先修正 models JSON。");
      elements.modelsJson.focus();
      return;
    }

    const body = {
      baseUrl: elements.baseUrl.value.trim(),
      api: elements.apiType.value,
      headers: headers.value,
    };
    if (state.selectedId) body.providerId = state.selectedId;
    if (elements.apiKey.value) body.apiKey = elements.apiKey.value;
    if (elements.authHeader.checked) body.authHeader = true;
    if (elements.discoveryType.value.trim()) body.discoveryType = elements.discoveryType.value.trim();

    setProbeBusy(true, "discover");
    setAlert(elements.discoveryWarning, "");
    try {
      const result = await request("/api/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      renderDiscoveryResult(result, models.value);
    } catch (error) {
      setAlert(elements.probeError, errorMessage(error, "模型发现失败。"));
    } finally {
      setProbeBusy(false, "discover");
    }
  }

  async function syncSelectedModels() {
    clearPageMessages();
    if (!elements.form.reportValidity()) return;

    const id = elements.providerId.value.trim();
    if (!id) {
      elements.providerId.setCustomValidity("请输入 Provider ID。");
      elements.providerId.reportValidity();
      return;
    }
    elements.providerId.setCustomValidity("");

    const selectedModels = state.modelEntries
      .filter((entry) => entry.selected)
      .map((entry) => structuredClone(modelForEntry(entry)));
    const definition = buildDefinition(selectedModels);
    if (!definition) return;
    delete definition.discovery;

    const body = { revision: state.revision, definition };
    const apiKey = elements.apiKey.value;
    if (apiKey) body.apiKey = apiKey;

    setFormBusy(true);
    elements.syncModelsButton.textContent = "正在更新…";
    try {
      const result = await request(`/api/providers/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      state.revision = result.revision;
      state.providers = result.providers;
      state.selectedId = id;
      state.originalDefinition = structuredClone(result.provider.definition);
      state.dirty = false;
      elements.editorMode.textContent = "EDIT PROVIDER";
      elements.editorTitle.textContent = id;
      elements.providerId.readOnly = true;
      elements.deleteButton.hidden = false;
      elements.credentialBadge.hidden = !hasCredential(result.provider.credential);
      elements.apiKey.value = "";
      elements.discoveryType.value = "";
      elements.modelsJson.value = formatJson(selectedModels, []);
      renderProviderList();
      renderModelCount();
      renderModelSelection();
      setAlert(elements.pageStatus, "models.yml 已更新；未选模型仍保留在当前目录中，可随时重新勾选。");
    } catch (error) {
      setAlert(elements.pageError, errorMessage(error, "更新 models.yml 失败。"));
    } finally {
      setFormBusy(false);
      elements.syncModelsButton.textContent = "更新 models.yml";
    }
  }

  async function runProbe() {
    setAlert(elements.probeError, "");
    if (!SUPPORTED_PROBE_APIS.has(elements.apiType.value)) {
      const message = `API 协议“${elements.apiType.value}”不支持自检，但可以保存配置。`;
      setAlert(elements.probeError, message);
      elements.probeSummary.textContent = "未运行自检；当前协议仍可正常保存。";
      return;
    }
    if (!elements.baseUrl.value.trim()) {
      setAlert(elements.probeError, "请先填写 Base URL。");
      elements.baseUrl.focus();
      return;
    }

    const includeInference = elements.runInference.checked;
    const model = elements.inferenceModel.value.trim();
    if (includeInference && !model) {
      setAlert(elements.probeError, "启用推理检测时必须填写或选择推理模型。");
      elements.inferenceModel.focus();
      return;
    }

    const headers = parseJsonField(elements.headersJson, elements.headersError, "headers");
    if (!headers.ok || !validateHeaders(headers.value)) {
      setAlert(elements.probeError, "请先修正 headers JSON。");
      elements.headersJson.focus();
      return;
    }

    const body = {
      baseUrl: elements.baseUrl.value.trim(),
      api: elements.apiType.value,
      runInference: includeInference,
    };
    if (state.selectedId) body.providerId = state.selectedId;
    if (elements.apiKey.value) body.apiKey = elements.apiKey.value;
    if (elements.authHeader.checked) body.authHeader = true;
    if (elements.discoveryType.value.trim()) body.discoveryType = elements.discoveryType.value.trim();
    if (includeInference) body.model = model;
    body.headers = headers.value;

    setProbeBusy(true, "probe");
    elements.probeSummary.textContent = "正在运行分层自检…";
    elements.checkList.setAttribute("aria-busy", "true");
    try {
      const result = await request("/api/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      renderProbeResult(result);
    } catch (error) {
      setAlert(elements.probeError, errorMessage(error, "自检失败。"));
      elements.probeSummary.textContent = "自检未完成。";
    } finally {
      elements.checkList.setAttribute("aria-busy", "false");
      setProbeBusy(false, "probe");
    }
  }

  elements.form.addEventListener("input", () => {
    state.dirty = true;
    clearPageMessages();
  });
  elements.providerId.addEventListener("input", () => elements.providerId.setCustomValidity(""));
  elements.runInference.addEventListener("change", () => {
    elements.inferenceModel.disabled = state.formBusy || !elements.runInference.checked;
    if (elements.runInference.checked) elements.inferenceModel.focus();
  });
  elements.form.addEventListener("submit", saveProvider);
  elements.deleteButton.addEventListener("click", deleteProvider);
  elements.newButton.addEventListener("click", startNew);
  elements.reloadButton.addEventListener("click", () => {
    if (confirmDiscard()) {
      state.dirty = false;
      loadProviders(state.selectedId, true);
    }
  });
  elements.modelSearch.addEventListener("input", renderModelSelection);
  elements.selectAllModels.addEventListener("click", () => {
    for (const entry of state.modelEntries) entry.selected = true;
    renderModelCount();
    renderModelSelection();
  });
  elements.selectNoModels.addEventListener("click", () => {
    for (const entry of state.modelEntries) entry.selected = false;
    renderModelCount();
    renderModelSelection();
  });
  elements.addModelButton.addEventListener("click", () => openModelEditor());
  elements.modelEditorForm.addEventListener("submit", saveModelEditor);
  elements.modelEditorClose.addEventListener("click", closeModelEditor);
  elements.modelEditorCancel.addEventListener("click", closeModelEditor);
  elements.modelEditorDialog.addEventListener("close", () => {
    state.editingModelId = null;
    setAlert(elements.modelEditorError, "");
  });
  elements.modelSupportsTools.addEventListener("change", () => {
    elements.modelSupportsTools.dataset.configured = "true";
  });
  elements.syncModelsButton.addEventListener("click", syncSelectedModels);
  elements.discoverButton.addEventListener("click", runDiscover);
  elements.probeButton.addEventListener("click", runProbe);

  loadProviders();
})();
