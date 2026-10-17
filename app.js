(function () {
  const config = window.SUPABASE_CONFIG || {};
  const supabaseUrl = config.url;
  const supabaseKey = config.anonKey;

  if (!supabaseUrl || !supabaseKey) {
    alert("Falta configurar Supabase. Crea config.js basado en config.example.js");
    return;
  }

  const db = supabase.createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
  const toast = new bootstrap.Toast(document.getElementById("status-toast"));

  const state = {
    user: null,
    clientes: [],
    productos: [],
    ventas: [],
    detventas: [],
    editing: {
      clientes: null,
      productos: null,
      ventas: null,
      detventas: null
    }
  };

  const TABLE_KEY = {
    clientes: "codcli",
    productos: "codprod",
    ventas: "codventa"
  };
  let sessionRecoveryInFlight = false;
  const reportCharts = {
    monthly: null,
    topClientes: null,
    deudaPendiente: null
  };

  const $ = (id) => document.getElementById(id);

  function showToast(message, isError) {
    const messageNode = $("toast-message");
    if (!messageNode) return;
    messageNode.textContent = message;
    messageNode.style.color = isError ? "#fecaca" : "#a7f3d0";
    toast.show();
  }

  function setAuthStatus(message, isError) {
    const node = $("auth-status");
    if (!node) return;
    node.textContent = message;
    node.className = isError ? "auth-feedback mt-3 error" : "auth-feedback mt-3 ok";
  }

  async function withButtonLoading(btn, loadingLabel, task) {
    if (!btn) return await task();
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span><span>${escapeHtml(loadingLabel)}</span>`;
    try {
      return await task();
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.innerHTML = originalHtml;
    }
  }

  function showAuth() {
    $("auth-view").classList.remove("d-none");
    $("app-view").classList.add("d-none");
  }

  function showApp() {
    $("auth-view").classList.add("d-none");
    $("app-view").classList.remove("d-none");
  }

  function clearAppState() {
    state.user = null;
    state.clientes = [];
    state.productos = [];
    state.ventas = [];
    state.detventas = [];
    state.editing = {
      clientes: null,
      productos: null,
      ventas: null,
      detventas: null
    };
  }

  function applySession(session) {
    if (!session || !session.user) return false;
    state.user = session.user;
    $("user-email").textContent = state.user.email || "Usuario";
    showApp();
    return true;
  }

  async function recoverSession() {
    if (sessionRecoveryInFlight) return;
    sessionRecoveryInFlight = true;
    try {
      const previousUser = state.user ? state.user.id : null;
      const currentSession = await ensureActiveSession({ forceRefresh: true });
      const changedUser = previousUser !== currentSession.user.id;
      const wasHidden = $("app-view").classList.contains("d-none");
      const shouldReload = changedUser || wasHidden || !state.clientes.length;
      if (shouldReload) {
        await loadAllData({ skipSessionCheck: true });
      }
    } catch (err) {
      clearAppState();
      showAuth();
      setAuthStatus("Tu sesión expiró. Ingresa nuevamente.", true);
      showToast(err.message, true);
    } finally {
      sessionRecoveryInFlight = false;
    }
  }

  function isSessionError(err) {
    const msg = String(err && err.message ? err.message : "").toLowerCase();
    return (
      msg.includes("jwt") ||
      msg.includes("session") ||
      msg.includes("refresh token") ||
      msg.includes("auth")
    );
  }

  async function ensureActiveSession(options = {}) {
    const forceRefresh = !!options.forceRefresh;
    try {
      const { data, error } = await db.auth.getSession();
      if (error) throw error;
      if (!data.session) {
        throw new Error("Sesión expirada. Ingresa nuevamente.");
      }

      let currentSession = data.session;
      const nowInSeconds = Math.floor(Date.now() / 1000);
      const expiresIn = Number(currentSession.expires_at || 0) - nowInSeconds;
      if (forceRefresh || expiresIn <= 90) {
        const { data: refreshed, error: refreshError } = await db.auth.refreshSession();
        if (refreshError) throw refreshError;
        if (refreshed && refreshed.session) {
          currentSession = refreshed.session;
        }
      }

      // Validate session against auth server (getSession alone is local cache).
      let userRes = await db.auth.getUser();
      if (userRes.error || !userRes.data || !userRes.data.user) {
        const { data: refreshed, error: refreshError } = await db.auth.refreshSession();
        if (refreshError) throw refreshError;
        if (!refreshed || !refreshed.session) {
          throw new Error("Sesión expirada. Ingresa nuevamente.");
        }
        currentSession = refreshed.session;
        userRes = await db.auth.getUser();
        if (userRes.error || !userRes.data || !userRes.data.user) {
          throw (userRes.error || new Error("Sesión expirada. Ingresa nuevamente."));
        }
      }

      applySession(currentSession);
      return currentSession;
    } catch (err) {
      clearAppState();
      showAuth();
      setAuthStatus("Tu sesión expiró. Ingresa nuevamente.", true);
      throw err;
    }
  }

  async function withSessionRetry(task) {
    await ensureActiveSession();
    try {
      return await task();
    } catch (err) {
      if (!isSessionError(err)) throw err;
      await ensureActiveSession({ forceRefresh: true });
      return await task();
    }
  }

  function formatMoney(value) {
    const n = Number(value || 0);
    return `S/ ${n.toFixed(2)}`;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderEmptyRow(colspan, message, icon = "bi-inbox") {
    return `
      <tr>
        <td colspan="${colspan}" class="empty-state">
          <i class="bi ${icon} empty-state-icon" aria-hidden="true"></i>
          <div>${escapeHtml(message)}</div>
        </td>
      </tr>`;
  }

  function updateFormModeUI(section, editingLabel) {
    const badge = $(`form-mode-${section}`);
    const submitBtn = $(`submit-${section}`);
    const defaultLabel = section === "ventas" || section === "detventas" ? "Nueva" : "Nuevo";
    if (badge) {
      if (editingLabel) {
        badge.textContent = `Editando: ${editingLabel}`;
        badge.classList.add("is-editing");
      } else {
        badge.textContent = defaultLabel;
        badge.classList.remove("is-editing");
      }
    }
    if (submitBtn) {
      const span = submitBtn.querySelector("span");
      if (span) {
        span.textContent = editingLabel ? "Actualizar" : "Guardar";
      }
    }
  }

  function updateStats() {
    const total = state.detventas.reduce((acc, row) => acc + Number(row.subtotal || 0), 0);
    $("stat-clientes").textContent = state.clientes.length;
    $("stat-productos").textContent = state.productos.length;
    $("stat-ventas").textContent = state.ventas.length;
    $("stat-total").textContent = formatMoney(total);

    const areasCount = new Set(state.clientes.map((c) => String(c.area || "").trim().toUpperCase()).filter(Boolean)).size;
    if ($("stat-clientes-sub")) {
      $("stat-clientes-sub").textContent = areasCount ? `${areasCount} área(s) registrada(s)` : "Cartera activa";
    }

    const lowStockCount = state.productos.filter((p) => Number(p.stock || 0) <= 5).length;
    if ($("stat-productos-sub")) {
      $("stat-productos-sub").textContent = lowStockCount
        ? `${lowStockCount} con stock bajo (≤ 5)`
        : "Stock saludable";
    }

    const pendientesCount = state.ventas.filter((v) => String(v.estado || "").toUpperCase() === "PENDIENTE").length;
    if ($("stat-ventas-sub")) {
      $("stat-ventas-sub").textContent = pendientesCount
        ? `${pendientesCount} pendiente(s) de cobro`
        : "Todas al día";
    }

    const totalByVenta = getVentaTotalMap();
    let montoPendiente = 0;
    for (const v of state.ventas) {
      if (String(v.estado || "").toUpperCase() === "PENDIENTE") {
        montoPendiente += Number(totalByVenta.get(v.codventa) || 0);
      }
    }
    if ($("stat-total-sub")) {
      $("stat-total-sub").textContent = montoPendiente > 0
        ? `Por cobrar: ${formatMoney(montoPendiente)}`
        : "Sin deuda pendiente";
    }
  }

  function setOptions(selectNode, rows, valueField, labelBuilder) {
    if (!selectNode) return;
    const options = rows
      .map((row) => `<option value="${escapeHtml(row[valueField])}">${escapeHtml(labelBuilder(row))}</option>`)
      .join("");
    selectNode.innerHTML = rows.length ? options : '<option value="">Sin datos</option>';
  }

  function buildVentaClienteLabel(cliente) {
    return `${cliente.codcli} - ${cliente.nombres_apellido}`;
  }

  function isAllClientesValue(rawValue) {
    const upper = String(rawValue || "").trim().toUpperCase();
    return !upper || upper === "ALL" || upper === "TODOS LOS CLIENTES";
  }

  function getVentaClienteCode(rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) return "";
    const upper = raw.toUpperCase();

    const byCode = state.clientes.find((c) => String(c.codcli || "").toUpperCase() === upper);
    if (byCode) return byCode.codcli;

    const parsedCode = raw.split(" - ")[0].trim().toUpperCase();
    const byParsedCode = state.clientes.find((c) => String(c.codcli || "").toUpperCase() === parsedCode);
    if (byParsedCode) return byParsedCode.codcli;

    const byLabel = state.clientes.find((c) => buildVentaClienteLabel(c).toUpperCase() === upper);
    if (byLabel) return byLabel.codcli;

    return "";
  }

  function setVentaClienteInputByCode(codcli) {
    const input = $("venta-codcli");
    if (!input) return;
    const cliente = state.clientes.find((c) => c.codcli === codcli);
    input.value = cliente ? buildVentaClienteLabel(cliente) : (codcli || "");
  }

  function getClienteFilterCode(rawValue) {
    if (isAllClientesValue(rawValue)) return "ALL";
    const codcli = getVentaClienteCode(rawValue);
    return codcli || "";
  }

  function setClienteFilterInputValue(inputId, codcli) {
    const input = $(inputId);
    if (!input) return;
    if (!codcli || codcli === "ALL") {
      input.value = "Todos los clientes";
      return;
    }
    const cliente = state.clientes.find((c) => c.codcli === codcli);
    input.value = cliente ? buildVentaClienteLabel(cliente) : "Todos los clientes";
  }

  function syncClienteFilterDatalist(listId) {
    const listNode = $(listId);
    if (!listNode) return;
    listNode.innerHTML = [
      '<option value="Todos los clientes"></option>',
      ...state.clientes.map((c) => `<option value="${escapeHtml(buildVentaClienteLabel(c))}"></option>`)
    ].join("");
  }

  function syncVentaClienteInput() {
    const listNode = $("venta-codcli-list");
    if (!listNode) return;
    listNode.innerHTML = state.clientes
      .map((c) => `<option value="${escapeHtml(buildVentaClienteLabel(c))}"></option>`)
      .join("");

    const inputNode = $("venta-codcli");
    if (!inputNode) return;
    const currentCode = getVentaClienteCode(inputNode.value);
    if (!currentCode && state.clientes.length && !state.editing.ventas) {
      setVentaClienteInputByCode(state.clientes[0].codcli);
      return;
    }
    if (currentCode) {
      setVentaClienteInputByCode(currentCode);
    }
  }

  function syncSelects() {
    syncVentaClienteInput();
    setOptions($("detventa-codventa"), state.ventas, "codventa", (v) => `${v.codventa} - ${v.fechaventa || ""}`);
    setOptions($("detventa-codprod"), state.productos, "codprod", (p) => `${p.codprod} - ${p.descripcion}`);
  }

  function setOptionsWithDefault(selectNode, rows, valueField, labelBuilder, defaultOption) {
    if (!selectNode) return;
    const options = rows
      .map((row) => `<option value="${escapeHtml(row[valueField])}">${escapeHtml(labelBuilder(row))}</option>`)
      .join("");
    selectNode.innerHTML = `${defaultOption}${options}`;
  }

  function getPeriodLabel(key) {
    if (key === "ALL") return "Todo el tiempo";
    if (key.startsWith("YEAR:")) {
      const year = key.split(":")[1];
      return `Año ${year}`;
    }
    if (key.startsWith("MONTH:")) {
      const ym = key.split(":")[1];
      const [y, m] = ym.split("-");
      const d = new Date(Number(y), Number(m) - 1, 1);
      const label = d.toLocaleDateString("es-PE", { month: "long", year: "numeric" });
      return `Mes ${label}`;
    }
    return key;
  }

  function buildResumenFilters() {
    const clienteInput = $("resumen-filter-cliente");
    const periodoSelect = $("resumen-filter-periodo");
    const estadoSelect = $("resumen-filter-estado");
    if (!clienteInput || !periodoSelect || !estadoSelect) return;

    const selectedCliente = getClienteFilterCode(clienteInput.value) || "ALL";
    const selectedPeriodo = periodoSelect.value || "ALL";
    const selectedEstado = estadoSelect.value || "ALL";

    syncClienteFilterDatalist("resumen-filter-cliente-list");
    setClienteFilterInputValue("resumen-filter-cliente", selectedCliente);

    const years = new Set();
    const months = new Set();
    for (const venta of state.ventas) {
      const fecha = String(venta.fechaventa || "");
      if (!fecha || !fecha.includes("-")) continue;
      const [year, month] = fecha.split("-");
      if (year) years.add(year);
      if (year && month) months.add(`${year}-${month}`);
    }

    const yearOptions = [...years]
      .sort((a, b) => Number(b) - Number(a))
      .map((year) => ({ key: `YEAR:${year}`, label: `Año ${year}` }));
    const monthOptions = [...months]
      .sort((a, b) => (a < b ? 1 : -1))
      .map((ym) => ({ key: `MONTH:${ym}`, label: getPeriodLabel(`MONTH:${ym}`) }));
    const periodRows = [...yearOptions, ...monthOptions];

    setOptionsWithDefault(
      periodoSelect,
      periodRows,
      "key",
      (p) => p.label,
      '<option value="ALL">Todo el tiempo</option>'
    );

    const estadoRows = [
      { key: "PENDIENTE", label: "Pendiente" },
      { key: "CANCELADO", label: "Cancelado" }
    ];
    setOptionsWithDefault(
      estadoSelect,
      estadoRows,
      "key",
      (e) => e.label,
      '<option value="ALL">Todos los estados</option>'
    );

    setClienteFilterInputValue("resumen-filter-cliente", selectedCliente);
    periodoSelect.value = [...periodoSelect.options].some((o) => o.value === selectedPeriodo) ? selectedPeriodo : "ALL";
    estadoSelect.value = [...estadoSelect.options].some((o) => o.value === selectedEstado) ? selectedEstado : "ALL";
  }

  function ventaMatchesPeriodo(venta, periodo) {
    if (!periodo || periodo === "ALL") return true;
    const fecha = String(venta.fechaventa || "");
    if (periodo.startsWith("YEAR:")) {
      const year = periodo.split(":")[1];
      return fecha.startsWith(`${year}-`);
    }
    if (periodo.startsWith("MONTH:")) {
      const ym = periodo.split(":")[1];
      return fecha.startsWith(`${ym}-`);
    }
    return true;
  }

  function ventaMatchesEstado(venta, estado) {
    if (!estado || estado === "ALL") return true;
    return String(venta.estado || "").toUpperCase() === estado;
  }

  function getEstadoTagClass(estado) {
    const normalized = String(estado || "").toUpperCase();
    if (normalized === "PENDIENTE") return "linea-tag estado-pendiente";
    if (normalized === "CANCELADO") return "linea-tag estado-cancelado";
    return "linea-tag";
  }

  function getEstadoBadgeClass(estado) {
    const normalized = String(estado || "").toUpperCase();
    if (normalized === "PENDIENTE") return "estado-badge estado-badge-pendiente";
    if (normalized === "CANCELADO") return "estado-badge estado-badge-cancelado";
    return "estado-badge";
  }

  function getVentaTotalMap() {
    const map = new Map();
    for (const det of state.detventas) {
      const codventa = det.codventa;
      const subtotal = Number(det.subtotal || 0);
      map.set(codventa, (map.get(codventa) || 0) + subtotal);
    }
    return map;
  }

  function buildReportePrintClienteOptions() {
    const clienteInput = $("reporte-print-cliente");
    const estadoSelect = $("reporte-print-estado");
    if (!clienteInput || !estadoSelect) return;
    const selectedCliente = getClienteFilterCode(clienteInput.value) || "ALL";
    const selectedEstado = estadoSelect.value || "ALL";

    syncClienteFilterDatalist("reporte-print-cliente-list");
    setClienteFilterInputValue("reporte-print-cliente", selectedCliente);

    const estadoRows = [
      { key: "PENDIENTE", label: "Pendiente" },
      { key: "CANCELADO", label: "Cancelado" }
    ];
    setOptionsWithDefault(
      estadoSelect,
      estadoRows,
      "key",
      (e) => e.label,
      '<option value="ALL">Todos</option>'
    );
    estadoSelect.value = [...estadoSelect.options].some((o) => o.value === selectedEstado) ? selectedEstado : "ALL";
  }

  function destroyChart(instance) {
    if (instance && typeof instance.destroy === "function") {
      instance.destroy();
    }
  }

  function renderReportCharts() {
    if (!window.Chart) return;
    const monthlyCanvas = $("chart-ventas-mensuales");
    const topCanvas = $("chart-top-clientes");
    const deudaCanvas = $("chart-deuda-pendiente");
    if (!monthlyCanvas || !topCanvas || !deudaCanvas) return;

    const byCli = new Map(state.clientes.map((c) => [c.codcli, c]));
    const totalByVenta = getVentaTotalMap();

    const monthlyCount = new Map();
    const monthlyMonto = new Map();
    for (const venta of state.ventas) {
      const fecha = String(venta.fechaventa || "");
      const ym = fecha.length >= 7 ? fecha.slice(0, 7) : "Sin fecha";
      monthlyCount.set(ym, (monthlyCount.get(ym) || 0) + 1);
      const sub = Number(totalByVenta.get(venta.codventa) || 0);
      monthlyMonto.set(ym, (monthlyMonto.get(ym) || 0) + sub);
    }
    const monthlyRows = [...monthlyCount.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1));
    const monthlyLabels = monthlyRows.map(([k]) => k);
    const monthlyValues = monthlyRows.map(([, v]) => v);
    const monthlyMontos = monthlyRows.map(([k]) => monthlyMonto.get(k));

    const consumoByCliente = new Map();
    for (const venta of state.ventas) {
      if (String(venta.estado || "").toUpperCase() === "CANCELADO") continue;
      const current = consumoByCliente.get(venta.codcli) || 0;
      consumoByCliente.set(venta.codcli, current + Number(totalByVenta.get(venta.codventa) || 0));
    }
    const topRows = [...consumoByCliente.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const topLabels = topRows.map(([codcli]) => {
      const cli = byCli.get(codcli);
      return cli ? cli.nombres_apellido : codcli;
    });
    const topValues = topRows.map(([, total]) => Number(total.toFixed(2)));

    const deudaByCliente = new Map();
    for (const venta of state.ventas) {
      if (String(venta.estado || "").toUpperCase() !== "PENDIENTE") continue;
      const current = deudaByCliente.get(venta.codcli) || 0;
      deudaByCliente.set(venta.codcli, current + Number(totalByVenta.get(venta.codventa) || 0));
    }
    const deudaRows = [...deudaByCliente.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const deudaLabels = deudaRows.map(([codcli]) => {
      const cli = byCli.get(codcli);
      return cli ? cli.nombres_apellido : codcli;
    });
    const deudaValues = deudaRows.map(([, total]) => Number(total.toFixed(2)));

    destroyChart(reportCharts.monthly);
    destroyChart(reportCharts.topClientes);
    destroyChart(reportCharts.deudaPendiente);

    Chart.defaults.font.family = '"Nunito Sans", system-ui, -apple-system, sans-serif';
    Chart.defaults.color = "#475569";

    reportCharts.monthly = new Chart(monthlyCanvas, {
      type: "line",
      data: {
        labels: monthlyLabels,
        datasets: [{
          label: "Operaciones de venta",
          data: monthlyValues,
          borderColor: "#1d4ed8",
          backgroundColor: "rgba(29, 78, 216, 0.12)",
          pointBackgroundColor: "#1d4ed8",
          pointRadius: 4,
          fill: true,
          tension: 0.25
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              afterLabel: function (context) {
                const monto = monthlyMontos[context.dataIndex];
                return "Monto vendido: S/ " + (monto || 0).toFixed(2);
              }
            }
          }
        }
      }
    });

    reportCharts.topClientes = new Chart(topCanvas, {
      type: "bar",
      data: {
        labels: topLabels,
        datasets: [{
          label: "Consumo (S/)",
          data: topValues,
          backgroundColor: "#047857",
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y"
      }
    });

    reportCharts.deudaPendiente = new Chart(deudaCanvas, {
      type: "bar",
      data: {
        labels: deudaLabels,
        datasets: [{
          label: "Deuda pendiente (S/)",
          data: deudaValues,
          backgroundColor: "#c2410c",
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });
  }

  function openPrintReporteA4() {
    const clienteInput = $("reporte-print-cliente");
    const estadoSelect = $("reporte-print-estado");
    const selectedCliente = clienteInput ? getClienteFilterCode(clienteInput.value) : "ALL";
    const selectedEstado = estadoSelect ? (estadoSelect.value || "ALL") : "ALL";
    if (!selectedCliente) {
      showToast("Cliente no válido. Selecciona un cliente de la lista o usa Todos los clientes.", true);
      return;
    }

    const byCli = new Map(state.clientes.map((c) => [c.codcli, c]));
    const byProd = new Map(state.productos.map((p) => [p.codprod, p]));
    const ventas = state.ventas
      .filter((v) => selectedCliente === "ALL" || v.codcli === selectedCliente)
      .filter((v) => ventaMatchesEstado(v, selectedEstado))
      .sort((a, b) => String(b.fechaventa || "").localeCompare(String(a.fechaventa || "")));

    if (!ventas.length) {
      showToast("No hay ventas para imprimir con ese filtro.", true);
      return;
    }

    const detalleRows = ventas.map((venta) => {
      const cliente = byCli.get(venta.codcli);
      const detalles = state.detventas.filter((d) => d.codventa === venta.codventa);
      const total = detalles.reduce((acc, d) => acc + Number(d.subtotal || 0), 0);
      const detailHtml = detalles.length
        ? detalles.map((d) => {
            const prod = byProd.get(d.codprod);
            return `<tr>
              <td>${escapeHtml(venta.codventa)}</td>
              <td>${escapeHtml(venta.fechaventa || "")}</td>
              <td>${escapeHtml(cliente ? cliente.nombres_apellido : venta.codcli)}</td>
              <td>${escapeHtml(prod ? prod.descripcion : d.codprod)}</td>
              <td>${escapeHtml(d.cantidad)}</td>
              <td>${formatMoney(d.subtotal)}</td>
              <td>${escapeHtml(venta.estado || "-")}</td>
            </tr>`;
          }).join("")
        : `<tr>
            <td>${escapeHtml(venta.codventa)}</td>
            <td>${escapeHtml(venta.fechaventa || "")}</td>
            <td>${escapeHtml(cliente ? cliente.nombres_apellido : venta.codcli)}</td>
            <td>Sin detalle</td>
            <td>-</td>
            <td>${formatMoney(0)}</td>
            <td>${escapeHtml(venta.estado || "-")}</td>
          </tr>`;
      return { detailHtml, total };
    });

    const totalsByEstado = detalleRows.reduce((acc, row, idx) => {
      const estado = String(ventas[idx].estado || "").toUpperCase();
      if (estado === "PENDIENTE") acc.pendiente += row.total;
      if (estado === "CANCELADO") acc.cancelado += row.total;
      return acc;
    }, { pendiente: 0, cancelado: 0 });
    const totalGeneral = detalleRows.reduce((acc, row) => acc + row.total, 0);
    const selectedLabel = selectedCliente === "ALL"
      ? "Todos los clientes"
      : (byCli.get(selectedCliente) ? byCli.get(selectedCliente).nombres_apellido : selectedCliente);
    const estadoLabel = selectedEstado === "ALL" ? "Todos" : selectedEstado;
    const nowLabel = new Date().toLocaleString("es-PE");
    const bodyRows = detalleRows.map((x) => x.detailHtml).join("");
    const printable = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Reporte de ventas — Tienda Persa</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: "Nunito Sans", system-ui, -apple-system, sans-serif; color:#0f172a; font-size: 12px; font-variant-numeric: tabular-nums; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 800; }
  .meta { color:#475569; margin-bottom: 14px; line-height: 1.5; }
  table { width:100%; border-collapse: collapse; }
  th, td { border:1px solid #cbd5e1; padding:7px 8px; text-align:left; vertical-align: top; }
  th { background:#f1f5f9; font-weight: 700; text-transform: uppercase; font-size: 11px; color: #334155; }
  .totals-wrap { margin-top: 14px; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .total { font-weight: 700; font-size: 13px; }
  .total-highlight { font-size: 15px; color: #1d4ed8; }
</style></head>
<body>
  <h1>Tienda Persa — Reporte detallado de ventas</h1>
  <div class="meta"><strong>Cliente:</strong> ${escapeHtml(selectedLabel)}<br><strong>Estado:</strong> ${escapeHtml(estadoLabel)}<br><strong>Generado:</strong> ${escapeHtml(nowLabel)}</div>
  <table>
    <thead>
      <tr>
        <th>Venta</th><th>Fecha</th><th>Cliente</th><th>Producto</th><th>Cant.</th><th>Subtotal</th><th>Estado</th>
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <div class="totals-wrap">
    <div class="total">Total Pendiente: ${formatMoney(totalsByEstado.pendiente)}</div>
    <div class="total">Total Cancelado: ${formatMoney(totalsByEstado.cancelado)}</div>
    <div class="total total-highlight">Total general: ${formatMoney(totalGeneral)}</div>
  </div>
</body></html>`;

    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      showToast("No se pudo abrir la ventana de impresión.", true);
      return;
    }
    printWindow.document.open();
    printWindow.document.write(printable);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  function getNextCode(rows, field, prefix, size) {
    let max = 0;
    const rgx = new RegExp(`^${prefix}(\\d+)$`, "i");
    for (const row of rows) {
      const value = String(row[field] || "").trim();
      const m = value.match(rgx);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
    const next = max + 1;
    return `${prefix}${String(next).padStart(size, "0")}`;
  }

  function applyAutoCodes() {
    if (!state.editing.clientes) {
      $("cliente-codcli").value = getNextCode(state.clientes, "codcli", "C", 4);
    }
    if (!state.editing.productos) {
      $("producto-codprod").value = getNextCode(state.productos, "codprod", "P", 4);
    }
    if (!state.editing.ventas) {
      $("venta-codventa").value = getNextCode(state.ventas, "codventa", "V", 4);
    }
  }

  function renderClientes() {
    const body = $("clientes-body");
    if (!body) return;
    const query = ($("search-clientes") ? $("search-clientes").value : "").trim().toLowerCase();
    const filtered = state.clientes.filter((row) => {
      if (!query) return true;
      return (
        String(row.codcli || "").toLowerCase().includes(query) ||
        String(row.nombres_apellido || "").toLowerCase().includes(query) ||
        String(row.area || "").toLowerCase().includes(query)
      );
    });

    if (!filtered.length) {
      body.innerHTML = renderEmptyRow(
        4,
        query ? "No se encontraron clientes con ese criterio de búsqueda." : "Aún no hay clientes registrados.",
        "bi-people"
      );
      return;
    }

    body.innerHTML = filtered
      .map(
        (row) => `
        <tr>
          <td class="fw-semibold tabular-nums">${escapeHtml(row.codcli)}</td>
          <td class="fw-medium">${escapeHtml(row.nombres_apellido)}</td>
          <td><span class="estado-badge">${escapeHtml(row.area)}</span></td>
          <td class="text-end">
            <div class="row-actions">
              <button class="btn-icon btn-edit" type="button" data-action="edit" data-table="clientes" data-id="${escapeHtml(row.codcli)}" aria-label="Editar cliente ${escapeHtml(row.nombres_apellido)}" title="Editar cliente">
                <i class="bi bi-pencil" aria-hidden="true"></i>
              </button>
              <button class="btn-icon btn-delete" type="button" data-action="delete" data-table="clientes" data-id="${escapeHtml(row.codcli)}" aria-label="Eliminar cliente ${escapeHtml(row.nombres_apellido)}" title="Eliminar cliente">
                <i class="bi bi-trash" aria-hidden="true"></i>
              </button>
            </div>
          </td>
        </tr>`
      )
      .join("");
  }

  function renderProductos() {
    const body = $("productos-body");
    if (!body) return;
    const query = ($("search-productos") ? $("search-productos").value : "").trim().toLowerCase();
    const filtered = state.productos.filter((row) => {
      if (!query) return true;
      return (
        String(row.codprod || "").toLowerCase().includes(query) ||
        String(row.descripcion || "").toLowerCase().includes(query) ||
        String(row.marca || "").toLowerCase().includes(query)
      );
    });

    if (!filtered.length) {
      body.innerHTML = renderEmptyRow(
        5,
        query ? "No se encontraron productos que coincidan con la búsqueda." : "Aún no hay productos registrados en el inventario.",
        "bi-box-seam"
      );
      return;
    }

    body.innerHTML = filtered
      .map((row) => {
        const stockNum = Number(row.stock || 0);
        const stockBadgeClass = stockNum <= 5 ? "stock-badge stock-badge-low" : "stock-badge stock-badge-ok";
        return `
        <tr>
          <td class="fw-semibold tabular-nums">${escapeHtml(row.codprod)}</td>
          <td>
            <div class="fw-medium">${escapeHtml(row.descripcion)}</div>
            <small class="text-secondary">${escapeHtml(row.marca)}</small>
          </td>
          <td class="fw-semibold tabular-nums">${formatMoney(row.precio)}</td>
          <td class="tabular-nums"><span class="${stockBadgeClass}">${escapeHtml(row.stock)} und.</span></td>
          <td class="text-end">
            <div class="row-actions">
              <button class="btn-icon btn-edit" type="button" data-action="edit" data-table="productos" data-id="${escapeHtml(row.codprod)}" aria-label="Editar producto ${escapeHtml(row.descripcion)}" title="Editar producto">
                <i class="bi bi-pencil" aria-hidden="true"></i>
              </button>
              <button class="btn-icon btn-delete" type="button" data-action="delete" data-table="productos" data-id="${escapeHtml(row.codprod)}" aria-label="Eliminar producto ${escapeHtml(row.descripcion)}" title="Eliminar producto">
                <i class="bi bi-trash" aria-hidden="true"></i>
              </button>
            </div>
          </td>
        </tr>`;
      })
      .join("");
  }

  function renderVentas() {
    const byCli = new Map(state.clientes.map((c) => [c.codcli, c]));
    const body = $("ventas-body");
    if (!body) return;
    const query = ($("search-ventas") ? $("search-ventas").value : "").trim().toLowerCase();
    const filtered = state.ventas.filter((row) => {
      if (!query) return true;
      const cli = byCli.get(row.codcli);
      const cliName = cli ? cli.nombres_apellido : row.codcli;
      return (
        String(row.codventa || "").toLowerCase().includes(query) ||
        String(cliName || "").toLowerCase().includes(query) ||
        String(row.fechaventa || "").toLowerCase().includes(query) ||
        String(row.estado || "").toLowerCase().includes(query)
      );
    });

    if (!filtered.length) {
      body.innerHTML = renderEmptyRow(
        5,
        query ? "No se encontraron ventas con ese filtro." : "Aún no hay operaciones de venta registradas.",
        "bi-receipt"
      );
      return;
    }

    body.innerHTML = filtered
      .map((row) => {
        const cli = byCli.get(row.codcli);
        return `
          <tr>
            <td class="fw-semibold tabular-nums">${escapeHtml(row.codventa)}</td>
            <td class="fw-medium">${escapeHtml(cli ? cli.nombres_apellido : row.codcli)}</td>
            <td class="tabular-nums">${escapeHtml(row.fechaventa)}</td>
            <td><span class="${getEstadoBadgeClass(row.estado)}">${escapeHtml(row.estado || "-")}</span></td>
            <td class="text-end">
              <div class="row-actions">
                <button class="btn-icon btn-edit" type="button" data-action="edit" data-table="ventas" data-id="${escapeHtml(row.codventa)}" aria-label="Editar venta ${escapeHtml(row.codventa)}" title="Editar venta">
                  <i class="bi bi-pencil" aria-hidden="true"></i>
                </button>
                <button class="btn-icon btn-delete" type="button" data-action="delete" data-table="ventas" data-id="${escapeHtml(row.codventa)}" aria-label="Eliminar venta ${escapeHtml(row.codventa)}" title="Eliminar venta">
                  <i class="bi bi-trash" aria-hidden="true"></i>
                </button>
              </div>
            </td>
          </tr>`;
      })
      .join("");
  }

  function renderDetventas() {
    const byProd = new Map(state.productos.map((p) => [p.codprod, p]));
    const body = $("detventas-body");
    if (!body) return;
    const query = ($("search-detventas") ? $("search-detventas").value : "").trim().toLowerCase();
    const filtered = state.detventas.filter((row) => {
      if (!query) return true;
      const p = byProd.get(row.codprod);
      const prodName = p ? p.descripcion : row.codprod;
      return (
        String(row.codventa || "").toLowerCase().includes(query) ||
        String(prodName || "").toLowerCase().includes(query)
      );
    });

    if (!filtered.length) {
      body.innerHTML = renderEmptyRow(
        5,
        query ? "No se encontraron líneas de detalle para esa búsqueda." : "Aún no hay detalles de venta registrados.",
        "bi-list-check"
      );
      return;
    }

    body.innerHTML = filtered
      .map((row) => {
        const p = byProd.get(row.codprod);
        const prodLabel = p ? p.descripcion : row.codprod;
        return `
          <tr>
            <td class="fw-semibold tabular-nums">${escapeHtml(row.codventa)}</td>
            <td class="fw-medium">${escapeHtml(prodLabel)}</td>
            <td class="tabular-nums">${escapeHtml(row.cantidad)}</td>
            <td class="fw-semibold tabular-nums">${formatMoney(row.subtotal)}</td>
            <td class="text-end">
              <div class="row-actions">
                <button class="btn-icon btn-edit" type="button" data-action="edit-det" data-id="${escapeHtml(`${row.codventa}::${row.codprod}`)}" aria-label="Editar detalle ${escapeHtml(row.codventa)} ${escapeHtml(prodLabel)}" title="Editar detalle">
                  <i class="bi bi-pencil" aria-hidden="true"></i>
                </button>
                <button class="btn-icon btn-delete" type="button" data-action="delete-det" data-id="${escapeHtml(`${row.codventa}::${row.codprod}`)}" aria-label="Eliminar detalle ${escapeHtml(row.codventa)} ${escapeHtml(prodLabel)}" title="Eliminar detalle">
                  <i class="bi bi-trash" aria-hidden="true"></i>
                </button>
              </div>
            </td>
          </tr>`;
      })
      .join("");
  }

  function renderResumen() {
    const byCli = new Map(state.clientes.map((c) => [c.codcli, c]));
    const byProd = new Map(state.productos.map((p) => [p.codprod, p]));
    const clienteFilter = $("resumen-filter-cliente") ? (getClienteFilterCode($("resumen-filter-cliente").value) || "ALL") : "ALL";
    const periodoFilter = $("resumen-filter-periodo") ? $("resumen-filter-periodo").value : "ALL";
    const estadoFilter = $("resumen-filter-estado") ? $("resumen-filter-estado").value : "ALL";
    const container = $("resumen-body");
    const filteredVentas = state.ventas.filter((venta) => {
      const byCliente = clienteFilter === "ALL" || venta.codcli === clienteFilter;
      const byPeriodo = ventaMatchesPeriodo(venta, periodoFilter);
      const byEstado = ventaMatchesEstado(venta, estadoFilter);
      return byCliente && byPeriodo && byEstado;
    });

    const cards = filteredVentas.map((venta) => {
      const cliente = byCli.get(venta.codcli);
      const detalles = state.detventas.filter((d) => d.codventa === venta.codventa);
      const total = detalles.reduce((acc, d) => acc + Number(d.subtotal || 0), 0);
      const lines = detalles.length
        ? detalles
            .map((d) => {
              const prod = byProd.get(d.codprod);
              return `
                <li class="d-flex justify-content-between align-items-center py-1 border-bottom">
                  <span>${escapeHtml(prod ? prod.descripcion : d.codprod)} <small class="text-secondary fw-semibold">×${escapeHtml(d.cantidad)}</small></span>
                  <span class="tabular-nums fw-medium">${formatMoney(d.subtotal)}</span>
                </li>`;
            })
            .join("")
        : '<li class="text-secondary py-1">Sin líneas en detalle</li>';

      return `
        <article class="resumen-card">
          <div>
            <div class="resumen-title mb-2">
              <div>
                <strong class="tabular-nums">${escapeHtml(venta.codventa)}</strong>
                <div class="small text-secondary fw-medium">${escapeHtml(cliente ? cliente.nombres_apellido : venta.codcli)}</div>
              </div>
              <div class="d-flex align-items-center gap-2">
                <div class="${getEstadoTagClass(venta.estado)} tabular-nums">${escapeHtml(venta.fechaventa || "")} · ${escapeHtml(venta.estado || "-")}</div>
                <button class="btn-icon btn-edit" type="button" data-action="toggle-estado-resumen" data-id="${escapeHtml(venta.codventa)}" aria-label="Cambiar estado de venta ${escapeHtml(venta.codventa)}" title="Cambiar estado (Pendiente / Cancelado)">
                  <i class="bi bi-arrow-repeat" aria-hidden="true"></i>
                </button>
              </div>
            </div>
            <ul class="list-unstyled mb-3">${lines}</ul>
          </div>
          <div class="d-flex justify-content-between align-items-center pt-1">
            <span class="small text-secondary">Total operación</span>
            <span class="fw-bold tabular-nums">${formatMoney(total)}</span>
          </div>
        </article>`;
    });

    const consumoTotal = filteredVentas.reduce((accVenta, venta) => {
      const totalVenta = state.detventas
        .filter((d) => d.codventa === venta.codventa)
        .reduce((accDet, d) => accDet + Number(d.subtotal || 0), 0);
      return accVenta + totalVenta;
    }, 0);
    const clienteLabel = clienteFilter === "ALL"
      ? "Todos los clientes"
      : (byCli.get(clienteFilter) ? byCli.get(clienteFilter).nombres_apellido : clienteFilter);
    const periodoLabel = getPeriodLabel(periodoFilter || "ALL");
    const estadoLabel = estadoFilter === "ALL" ? "Todos los estados" : estadoFilter;
    if ($("resumen-consumo-cliente")) $("resumen-consumo-cliente").textContent = formatMoney(consumoTotal);
    if ($("resumen-consumo-label")) $("resumen-consumo-label").textContent = `${clienteLabel} · ${periodoLabel} · ${estadoLabel}`;

    container.innerHTML = cards.length
      ? cards.join("")
      : '<div class="panel-surface text-center text-secondary py-4">No se encontraron ventas para los filtros seleccionados.</div>';
  }

  function getVencimientoEstado(fecha) {
    if (!fecha) return { label: "Sin fecha", code: "SIN_FECHA", class: "estado-badge" };
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const venc = new Date(fecha + "T00:00:00");
    const diffTime = venc.getTime() - hoy.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays <= 0) return { label: "Vencido", code: "VENCIDO", class: "estado-badge estado-badge-vencido", days: diffDays };
    if (diffDays <= 30) return { label: "Por vencer", code: "POR_VENCER", class: "estado-badge estado-badge-porvencer", days: diffDays };
    return { label: "Vigente", code: "VIGENTE", class: "estado-badge estado-badge-vigente", days: diffDays };
  }

  function renderVencimientos() {
    const body = $("vencimientos-body");
    if (!body) return;

    const query = ($("search-vencimientos") ? $("search-vencimientos").value : "").trim().toLowerCase();
    const estadoFilter = $("filter-vencimientos-estado") ? $("filter-vencimientos-estado").value : "ALL";

    const sorted = [...state.productos].sort((a, b) => {
      if (!a.fecha_vencimiento && !b.fecha_vencimiento) return 0;
      if (!a.fecha_vencimiento) return 1;
      if (!b.fecha_vencimiento) return -1;
      return new Date(a.fecha_vencimiento).getTime() - new Date(b.fecha_vencimiento).getTime();
    });

    const filtered = sorted.filter((row) => {
      const estado = getVencimientoEstado(row.fecha_vencimiento);
      if (estadoFilter !== "ALL" && estado.code !== estadoFilter) return false;
      if (!query) return true;
      return (
        String(row.codprod || "").toLowerCase().includes(query) ||
        String(row.descripcion || "").toLowerCase().includes(query) ||
        String(row.marca || "").toLowerCase().includes(query)
      );
    });

    if (!filtered.length) {
      body.innerHTML = renderEmptyRow(
        6,
        "No hay productos que coincidan con el filtro de vencimientos.",
        "bi-calendar-check"
      );
      return;
    }

    body.innerHTML = filtered
      .map((row) => {
        const estado = getVencimientoEstado(row.fecha_vencimiento);
        const daysLabel = estado.days !== undefined ? `${estado.days} días` : "-";
        return `
        <tr>
          <td class="fw-semibold tabular-nums">${escapeHtml(row.codprod)}</td>
          <td>
            <div class="fw-medium">${escapeHtml(row.descripcion)}</div>
            <small class="text-secondary">${escapeHtml(row.marca)}</small>
          </td>
          <td class="tabular-nums">${escapeHtml(row.fecha_vencimiento || "-")}</td>
          <td class="tabular-nums fw-medium">${escapeHtml(daysLabel)}</td>
          <td class="tabular-nums">${escapeHtml(row.stock)}</td>
          <td><span class="${estado.class}">${estado.label}</span></td>
        </tr>`;
      })
      .join("");
  }

  function renderAll() {
    updateStats();
    syncSelects();
    buildResumenFilters();
    buildReportePrintClienteOptions();
    syncDetventaFromVenta();
    syncDetventaFromProducto();
    applyAutoCodes();
    renderClientes();
    renderProductos();
    renderVentas();
    renderDetventas();
    renderResumen();
    renderVencimientos();
    renderReportCharts();
  }

  function resetForm(section) {
    state.editing[section] = null;
    updateFormModeUI(section, null);
    if (section === "clientes") {
      $("clientes-form").reset();
      $("cliente-codcli").value = getNextCode(state.clientes, "codcli", "C", 4);
    }
    if (section === "productos") {
      $("productos-form").reset();
      $("producto-codprod").value = getNextCode(state.productos, "codprod", "P", 4);
    }
    if (section === "ventas") {
      $("ventas-form").reset();
      $("venta-codventa").value = getNextCode(state.ventas, "codventa", "V", 4);
      if (state.clientes.length) {
        setVentaClienteInputByCode(state.clientes[0].codcli);
      } else {
        $("venta-codcli").value = "";
      }
      $("venta-fechaventa").value = new Date().toISOString().slice(0, 10);
      $("venta-estado").value = "PENDIENTE";
    }
    if (section === "detventas") {
      $("detventas-form").reset();
      $("detventa-fechaventa").value = new Date().toISOString().slice(0, 10);
      $("detventa-estado").value = "";
    }
    syncSelects();
    if (section === "detventas") {
      syncDetventaFromVenta();
      syncDetventaFromProducto();
    }
    recalcSubtotal();
  }

  async function nextId(table) {
    const { data, error } = await db
      .from(table)
      .select("id")
      .order("id", { ascending: false })
      .limit(1);

    if (error) throw error;
    const last = data && data.length ? Number(data[0].id || 0) : 0;
    return last + 1;
  }

  async function loadAllData(options = {}) {
    if (!options.skipSessionCheck) {
      await ensureActiveSession();
    }
    if (!state.user) return;
    const uid = state.user.id;

    const [clientesRes, productosRes, ventasRes, detventasRes] = await withSessionRetry(() =>
      Promise.all([
        db.from("clientes").select("*").eq("user_id", uid).order("id", { ascending: false }),
        db.from("productos").select("*").eq("user_id", uid).order("id", { ascending: false }),
        db.from("ventas").select("*").eq("user_id", uid).order("id", { ascending: false }),
        db.from("detventas").select("*").eq("user_id", uid).order("id", { ascending: false })
      ])
    );

    for (const res of [clientesRes, productosRes, ventasRes, detventasRes]) {
      if (res.error) throw res.error;
    }

    state.clientes = clientesRes.data || [];
    state.productos = productosRes.data || [];
    state.ventas = ventasRes.data || [];
    state.detventas = detventasRes.data || [];
    renderAll();
  }

  function fillForm(section, row) {
    state.editing[section] = row;
    if (section === "clientes") {
      $("cliente-codcli").value = row.codcli;
      $("cliente-nombre").value = row.nombres_apellido;
      $("cliente-area").value = row.area;
      updateFormModeUI("clientes", row.codcli);
      $("cliente-nombre").focus();
    }
    if (section === "productos") {
      $("producto-codprod").value = row.codprod;
      $("producto-descripcion").value = row.descripcion;
      $("producto-marca").value = row.marca;
      $("producto-precio").value = row.precio;
      $("producto-stock").value = row.stock;
      $("producto-fecha-vencimiento").value = row.fecha_vencimiento;
      updateFormModeUI("productos", row.codprod);
      $("producto-descripcion").focus();
    }
    if (section === "ventas") {
      $("venta-codventa").value = row.codventa;
      setVentaClienteInputByCode(row.codcli);
      $("venta-fechaventa").value = row.fechaventa;
      $("venta-estado").value = row.estado || "PENDIENTE";
      updateFormModeUI("ventas", row.codventa);
      $("venta-codcli").focus();
    }
    if (section === "detventas") {
      $("detventa-codventa").value = row.codventa;
      $("detventa-codprod").value = row.codprod;
      $("detventa-fechaventa").value = row.fechaventa;
      $("detventa-cantidad").value = row.cantidad;
      $("detventa-precio").value = row.precio;
      $("detventa-subtotal").value = row.subtotal;
      $("detventa-estado").value = row.estado || "";
      syncDetventaFromVenta();
      syncDetventaFromProducto();
      recalcSubtotal();
      updateFormModeUI("detventas", `${row.codventa} · ${row.codprod}`);
      $("detventa-cantidad").focus();
    }
  }

  async function upsertSimple(table, section, payload) {
    await withSessionRetry(async () => {
      const current = state.editing[section];
      if (!current) {
        payload.id = await nextId(table);
        const { error } = await db.from(table).insert([payload]);
        if (error) throw error;
        showToast(`Registro guardado en ${section}`);
      } else {
        const key = TABLE_KEY[section];
        const { data, error } = await db
          .from(table)
          .update(payload)
          .select(key)
          .eq(key, current[key])
          .eq("user_id", state.user.id);
        if (error) throw error;
        if (!data || !data.length) {
          throw new Error("No se pudo actualizar. Tu sesión pudo expirar, vuelve a ingresar.");
        }
        showToast(`Registro actualizado en ${section}`);
      }
    });
    resetForm(section);
    await loadAllData();
  }

  function recalcSubtotal() {
    const cantidad = Number($("detventa-cantidad").value || 0);
    const precio = Number($("detventa-precio").value || 0);
    $("detventa-subtotal").value = (cantidad * precio).toFixed(2);
  }

  function syncDetventaFromVenta() {
    const codventa = $("detventa-codventa").value;
    const venta = state.ventas.find((v) => v.codventa === codventa);
    if (!venta) return;
    $("detventa-fechaventa").value = venta.fechaventa || "";
    $("detventa-estado").value = venta.estado || "";
  }

  function syncDetventaFromProducto() {
    const codprod = $("detventa-codprod").value;
    const producto = state.productos.find((p) => p.codprod === codprod);
    if (!producto) return;
    $("detventa-precio").value = Number(producto.precio || 0).toFixed(2);
    recalcSubtotal();
  }

  async function handleDelete(table, key, id) {
    const ok = confirm("¿Seguro que deseas eliminar este registro?");
    if (!ok) return;
    await withSessionRetry(async () => {
      const { data, error } = await db
        .from(table)
        .delete()
        .select(key)
        .eq(key, id)
        .eq("user_id", state.user.id);
      if (error) throw error;
      if (!data || !data.length) {
        throw new Error("No se pudo eliminar. Tu sesión pudo expirar, vuelve a ingresar.");
      }
    });
    showToast("Registro eliminado");
    await loadAllData();
  }

  async function handleDeleteDet(composite) {
    const [codventa, codprod] = composite.split("::");
    const ok = confirm("¿Eliminar detalle de venta?");
    if (!ok) return;
    await withSessionRetry(async () => {
      const { data, error } = await db
        .from("detventas")
        .delete()
        .select("codventa,codprod")
        .match({ codventa, codprod, user_id: state.user.id });
      if (error) throw error;
      if (!data || !data.length) {
        throw new Error("No se pudo eliminar. Tu sesión pudo expirar, vuelve a ingresar.");
      }
    });
    showToast("Detalle eliminado");
    await loadAllData();
  }

  function activateSection(section) {
    document.querySelectorAll(".module-tab").forEach((btn) => {
      const isActive = btn.dataset.section === section;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    document.querySelectorAll(".module-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `section-${section}`);
    });
    if (section === "reportes") {
      renderReportCharts();
    }
  }

  async function login(email, password) {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async function register(email, password) {
    const { error } = await db.auth.signUp({ email, password });
    if (error) throw error;
  }

  async function bootSession() {
    await recoverSession();
  }

  function bindEvents() {
    const tabs = Array.from(document.querySelectorAll(".module-tab"));
    tabs.forEach((btn, idx) => {
      btn.addEventListener("click", () => activateSection(btn.dataset.section));
      btn.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          const nextIdx = (idx + dir + tabs.length) % tabs.length;
          tabs[nextIdx].focus();
          activateSection(tabs[nextIdx].dataset.section);
        }
      });
    });

    document.querySelectorAll("[data-reset]").forEach((btn) => {
      btn.addEventListener("click", () => resetForm(btn.dataset.reset));
    });

    const togglePwdBtn = $("toggle-password-btn");
    if (togglePwdBtn) {
      togglePwdBtn.addEventListener("click", () => {
        const claveInput = $("clave");
        if (!claveInput) return;
        const isPwd = claveInput.type === "password";
        claveInput.type = isPwd ? "text" : "password";
        const icon = togglePwdBtn.querySelector("i");
        if (icon) {
          icon.className = isPwd ? "bi bi-eye-slash" : "bi bi-eye";
        }
      });
    }

    const refreshBtn = $("refresh-data-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async () => {
        try {
          await withButtonLoading(refreshBtn, "Sincronizando...", async () => {
            await loadAllData();
          });
          showToast("Datos sincronizados correctamente");
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    $("register-btn").addEventListener("click", async () => {
      try {
        const email = $("correo").value.trim();
        const password = $("clave").value.trim();
        await withButtonLoading($("register-btn"), "Registrando...", async () => {
          await register(email, password);
        });
        setAuthStatus("Registro exitoso. Revisa tu correo para confirmar si tu proyecto lo exige.");
      } catch (err) {
        setAuthStatus(err.message, true);
      }
    });

    $("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const email = $("correo").value.trim();
        const password = $("clave").value.trim();
        await withButtonLoading($("login-submit-btn"), "Ingresando...", async () => {
          await login(email, password);
        });
        setAuthStatus("");
      } catch (err) {
        setAuthStatus(err.message, true);
      }
    });

    $("logout-btn").addEventListener("click", async () => {
      try {
        await db.auth.signOut({ scope: "local" });
      } catch (_err) {
        // If token is already invalid, we still need to cleanup UI state.
      }
      clearAppState();
      showAuth();
    });

    $("clientes-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await withButtonLoading($("submit-clientes"), "Guardando...", async () => {
          await ensureActiveSession({ forceRefresh: true });
          await upsertSimple("clientes", "clientes", {
            codcli: $("cliente-codcli").value.trim(),
            nombres_apellido: $("cliente-nombre").value.trim(),
            area: $("cliente-area").value.trim(),
            user_id: state.user.id
          });
        });
      } catch (err) {
        showToast(err.message, true);
      }
    });

    $("productos-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await withButtonLoading($("submit-productos"), "Guardando...", async () => {
          await ensureActiveSession({ forceRefresh: true });
          await upsertSimple("productos", "productos", {
            codprod: $("producto-codprod").value.trim(),
            descripcion: $("producto-descripcion").value.trim(),
            marca: $("producto-marca").value.trim(),
            precio: Number($("producto-precio").value),
            stock: Number($("producto-stock").value),
            fecha_vencimiento: $("producto-fecha-vencimiento").value,
            user_id: state.user.id
          });
        });
      } catch (err) {
        showToast(err.message, true);
      }
    });

    $("ventas-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await withButtonLoading($("submit-ventas"), "Guardando...", async () => {
          await ensureActiveSession({ forceRefresh: true });
          const codcli = getVentaClienteCode($("venta-codcli").value);
          if (!codcli) {
            throw new Error("Selecciona un cliente válido de la lista.");
          }
          setVentaClienteInputByCode(codcli);
          await upsertSimple("ventas", "ventas", {
            codventa: $("venta-codventa").value.trim(),
            codcli,
            fechaventa: $("venta-fechaventa").value,
            estado: $("venta-estado").value,
            user_id: state.user.id
          });
        });
      } catch (err) {
        showToast(err.message, true);
      }
    });

    $("detventas-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await withButtonLoading($("submit-detventas"), "Guardando...", async () => {
          await ensureActiveSession({ forceRefresh: true });
          syncDetventaFromVenta();
          syncDetventaFromProducto();
          const payload = {
            codventa: $("detventa-codventa").value,
            codprod: $("detventa-codprod").value,
            fechaventa: $("detventa-fechaventa").value,
            cantidad: Number($("detventa-cantidad").value),
            precio: Number($("detventa-precio").value),
            subtotal: Number($("detventa-subtotal").value),
            estado: $("detventa-estado").value.trim(),
            user_id: state.user.id
          };

          const current = state.editing.detventas;
          if (!current) {
            await withSessionRetry(async () => {
              payload.id = await nextId("detventas");
              const { error } = await db.from("detventas").insert([payload]);
              if (error) throw error;
              showToast("Detalle registrado");
            });
          } else {
            await withSessionRetry(async () => {
              const { data, error } = await db
                .from("detventas")
                .update(payload)
                .select("codventa,codprod")
                .match({
                  codventa: current.codventa,
                  codprod: current.codprod,
                  user_id: state.user.id
                });
              if (error) throw error;
              if (!data || !data.length) {
                throw new Error("No se pudo actualizar. Tu sesión pudo expirar, vuelve a ingresar.");
              }
              showToast("Detalle actualizado");
            });
          }
          resetForm("detventas");
          await loadAllData();
        });
      } catch (err) {
        showToast(err.message, true);
      }
    });

    if ($("search-clientes")) $("search-clientes").addEventListener("input", renderClientes);
    if ($("search-productos")) $("search-productos").addEventListener("input", renderProductos);
    if ($("search-ventas")) $("search-ventas").addEventListener("input", renderVentas);
    if ($("search-detventas")) $("search-detventas").addEventListener("input", renderDetventas);
    if ($("search-vencimientos")) $("search-vencimientos").addEventListener("input", renderVencimientos);
    if ($("filter-vencimientos-estado")) $("filter-vencimientos-estado").addEventListener("change", renderVencimientos);

    $("detventa-cantidad").addEventListener("input", recalcSubtotal);
    $("detventa-precio").addEventListener("input", recalcSubtotal);
    $("venta-codcli").addEventListener("blur", () => {
      const codcli = getVentaClienteCode($("venta-codcli").value);
      if (codcli) {
        setVentaClienteInputByCode(codcli);
      }
    });

    $("detventa-fechaventa").addEventListener("keydown", (e) => {
      e.preventDefault();
    });
    $("detventa-fechaventa").addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    $("detventa-fechaventa").addEventListener("input", () => {
      syncDetventaFromVenta();
    });

    $("detventa-codprod").addEventListener("change", () => {
      syncDetventaFromProducto();
    });

    $("detventa-codventa").addEventListener("change", () => {
      syncDetventaFromVenta();
    });

    const normalizeResumenClienteFilter = () => {
      const input = $("resumen-filter-cliente");
      if (!input) return;
      const codcli = getClienteFilterCode(input.value);
      if (!codcli) {
        showToast("Cliente no válido. Se aplicará Todos los clientes.", true);
      }
      setClienteFilterInputValue("resumen-filter-cliente", codcli || "ALL");
    };

    $("resumen-filter-cliente").addEventListener("change", () => {
      normalizeResumenClienteFilter();
      renderResumen();
    });
    $("resumen-filter-cliente").addEventListener("blur", () => {
      normalizeResumenClienteFilter();
      renderResumen();
    });

    $("resumen-filter-periodo").addEventListener("change", () => {
      renderResumen();
    });

    $("resumen-filter-estado").addEventListener("change", () => {
      renderResumen();
    });

    $("reporte-print-cliente").addEventListener("blur", () => {
      const codcli = getClienteFilterCode($("reporte-print-cliente").value);
      if (!codcli) {
        showToast("Cliente no válido. Se aplicará Todos los clientes.", true);
      }
      setClienteFilterInputValue("reporte-print-cliente", codcli || "ALL");
    });

    $("reporte-print-btn").addEventListener("click", () => {
      openPrintReporteA4();
    });

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const table = btn.dataset.table;
      const id = btn.dataset.id;
      try {
        if (action === "edit") {
          const row = state[table].find((x) => String(x[TABLE_KEY[table]]) === String(id));
          if (row) fillForm(table, row);
        }
        if (action === "delete") {
          await handleDelete(table, TABLE_KEY[table], id);
        }
        if (action === "edit-det") {
          const [codventa, codprod] = id.split("::");
          const row = state.detventas.find((x) => x.codventa === codventa && x.codprod === codprod);
          if (row) fillForm("detventas", row);
        }
        if (action === "delete-det") {
          await handleDeleteDet(id);
        }
        if (action === "toggle-estado-resumen") {
          const venta = state.ventas.find((x) => String(x.codventa) === String(id));
          if (venta) {
            const nuevoEstado = venta.estado === "PENDIENTE" ? "CANCELADO" : "PENDIENTE";
            const ok = confirm(`¿Seguro que deseas cambiar el estado de la venta ${venta.codventa} a ${nuevoEstado}?`);
            if (ok) {
              await withSessionRetry(async () => {
                const { error } = await db
                  .from("ventas")
                  .update({ estado: nuevoEstado })
                  .select("codventa")
                  .eq("codventa", venta.codventa)
                  .eq("user_id", state.user.id);
                if (error) throw error;

                // Actualizar también en detventas por consistencia
                await db
                  .from("detventas")
                  .update({ estado: nuevoEstado })
                  .eq("codventa", venta.codventa)
                  .eq("user_id", state.user.id);
              });
              showToast("Estado actualizado correctamente");
              await loadAllData();
            }
          }
        }
      } catch (err) {
        showToast(err.message, true);
      }
    });

    db.auth.onAuthStateChange(async (event, session) => {
      if (!session) {
        clearAppState();
        showAuth();
        if (event !== "INITIAL_SESSION") {
          setAuthStatus("Tu sesión finalizó. Vuelve a ingresar.", true);
        }
        return;
      }
      const previousUser = state.user ? state.user.id : null;
      const changedUser = previousUser !== session.user.id;
      applySession(session);
      if (changedUser || event !== "TOKEN_REFRESHED") {
        await loadAllData({ skipSessionCheck: true });
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        recoverSession();
      }
    });

    window.addEventListener("focus", () => {
      recoverSession();
    });
  }

  async function init() {
    bindEvents();
    activateSection("clientes");
    resetForm("ventas");
    resetForm("detventas");
    try {
      await bootSession();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  init();
})();
