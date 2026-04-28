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
    messageNode.textContent = message;
    messageNode.style.color = isError ? "#ffbac7" : "#d7ffed";
    toast.show();
  }

  function setAuthStatus(message, isError) {
    const node = $("auth-status");
    node.textContent = message;
    node.className = isError ? "small mt-3 error" : "small mt-3 ok";
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
      setAuthStatus("Tu sesion expiro. Ingresa nuevamente.", true);
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
        throw new Error("Sesion expirada. Ingresa nuevamente.");
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
          throw new Error("Sesion expirada. Ingresa nuevamente.");
        }
        currentSession = refreshed.session;
        userRes = await db.auth.getUser();
        if (userRes.error || !userRes.data || !userRes.data.user) {
          throw (userRes.error || new Error("Sesion expirada. Ingresa nuevamente."));
        }
      }

      applySession(currentSession);
      return currentSession;
    } catch (err) {
      clearAppState();
      showAuth();
      setAuthStatus("Tu sesion expiro. Ingresa nuevamente.", true);
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

  function updateStats() {
    const total = state.detventas.reduce((acc, row) => acc + Number(row.subtotal || 0), 0);
    $("stat-clientes").textContent = state.clientes.length;
    $("stat-productos").textContent = state.productos.length;
    $("stat-ventas").textContent = state.ventas.length;
    $("stat-total").textContent = formatMoney(total);
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
    const clienteSelect = $("resumen-filter-cliente");
    const periodoSelect = $("resumen-filter-periodo");
    const estadoSelect = $("resumen-filter-estado");
    if (!clienteSelect || !periodoSelect || !estadoSelect) return;

    const selectedCliente = clienteSelect.value || "ALL";
    const selectedPeriodo = periodoSelect.value || "ALL";
    const selectedEstado = estadoSelect.value || "ALL";

    setOptionsWithDefault(
      clienteSelect,
      state.clientes,
      "codcli",
      (c) => `${c.codcli} - ${c.nombres_apellido}`,
      '<option value="ALL">Todos los clientes</option>'
    );

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

    clienteSelect.value = [...clienteSelect.options].some((o) => o.value === selectedCliente) ? selectedCliente : "ALL";
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
    const clienteSelect = $("reporte-print-cliente");
    if (!clienteSelect) return;
    setOptionsWithDefault(
      clienteSelect,
      state.clientes,
      "codcli",
      (c) => `${c.codcli} - ${c.nombres_apellido}`,
      '<option value="ALL">Todos los clientes</option>'
    );
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
    for (const venta of state.ventas) {
      const fecha = String(venta.fechaventa || "");
      const ym = fecha.length >= 7 ? fecha.slice(0, 7) : "Sin fecha";
      monthlyCount.set(ym, (monthlyCount.get(ym) || 0) + 1);
    }
    const monthlyRows = [...monthlyCount.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1));
    const monthlyLabels = monthlyRows.map(([k]) => k);
    const monthlyValues = monthlyRows.map(([, v]) => v);

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

    reportCharts.monthly = new Chart(monthlyCanvas, {
      type: "line",
      data: {
        labels: monthlyLabels,
        datasets: [{
          label: "Ventas",
          data: monthlyValues,
          borderColor: "#4f63d9",
          backgroundColor: "rgba(79,99,217,0.2)",
          fill: true,
          tension: 0.28
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });

    reportCharts.topClientes = new Chart(topCanvas, {
      type: "bar",
      data: {
        labels: topLabels,
        datasets: [{
          label: "Consumo S/",
          data: topValues,
          backgroundColor: "#5c8df6"
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
          label: "Deuda pendiente S/",
          data: deudaValues,
          backgroundColor: "#e07d5f"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });
  }

  function openPrintReporteA4() {
    const selectedCliente = $("reporte-print-cliente") ? $("reporte-print-cliente").value : "ALL";
    const byCli = new Map(state.clientes.map((c) => [c.codcli, c]));
    const byProd = new Map(state.productos.map((p) => [p.codprod, p]));
    const ventas = state.ventas
      .filter((v) => selectedCliente === "ALL" || v.codcli === selectedCliente)
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

    const totalGeneral = detalleRows.reduce((acc, row) => acc + row.total, 0);
    const selectedLabel = selectedCliente === "ALL"
      ? "Todos los clientes"
      : (byCli.get(selectedCliente) ? byCli.get(selectedCliente).nombres_apellido : selectedCliente);
    const nowLabel = new Date().toLocaleString("es-PE");
    const bodyRows = detalleRows.map((x) => x.detailHtml).join("");
    const printable = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Reporte de ventas</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: Arial, sans-serif; color:#1f2338; font-size: 12px; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .meta { color:#5b6282; margin-bottom: 12px; }
  table { width:100%; border-collapse: collapse; }
  th, td { border:1px solid #dfe3f3; padding:6px; text-align:left; vertical-align: top; }
  th { background:#f3f5ff; }
  .total { margin-top: 12px; text-align: right; font-weight: bold; font-size: 14px; }
</style></head>
<body>
  <h1>Reporte detallado de ventas por cliente</h1>
  <div class="meta">Cliente: ${escapeHtml(selectedLabel)}<br>Generado: ${escapeHtml(nowLabel)}</div>
  <table>
    <thead>
      <tr>
        <th>Venta</th><th>Fecha</th><th>Cliente</th><th>Producto</th><th>Cant.</th><th>Subtotal</th><th>Estado</th>
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <div class="total">Total general: ${formatMoney(totalGeneral)}</div>
</body></html>`;

    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      showToast("No se pudo abrir la ventana de impresion.", true);
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
    body.innerHTML = state.clientes
      .map(
        (row) => `
        <tr>
          <td>${escapeHtml(row.codcli)}</td>
          <td>${escapeHtml(row.nombres_apellido)}</td>
          <td>${escapeHtml(row.area)}</td>
          <td class="text-end">
            <div class="row-actions">
              <button class="btn-icon btn-edit" data-action="edit" data-table="clientes" data-id="${escapeHtml(row.codcli)}"><i class="bi bi-pencil"></i></button>
              <button class="btn-icon btn-delete" data-action="delete" data-table="clientes" data-id="${escapeHtml(row.codcli)}"><i class="bi bi-trash"></i></button>
            </div>
          </td>
        </tr>`
      )
      .join("");
  }

  function renderProductos() {
    const body = $("productos-body");
    body.innerHTML = state.productos
      .map(
        (row) => `
        <tr>
          <td>${escapeHtml(row.codprod)}</td>
          <td>${escapeHtml(row.descripcion)}<br><small class="text-muted">${escapeHtml(row.marca)}</small></td>
          <td>${formatMoney(row.precio)}</td>
          <td>${escapeHtml(row.stock)}</td>
          <td class="text-end">
            <div class="row-actions">
              <button class="btn-icon btn-edit" data-action="edit" data-table="productos" data-id="${escapeHtml(row.codprod)}"><i class="bi bi-pencil"></i></button>
              <button class="btn-icon btn-delete" data-action="delete" data-table="productos" data-id="${escapeHtml(row.codprod)}"><i class="bi bi-trash"></i></button>
            </div>
          </td>
        </tr>`
      )
      .join("");
  }

  function renderVentas() {
    const byCli = new Map(state.clientes.map((c) => [c.codcli, c]));
    const body = $("ventas-body");
    body.innerHTML = state.ventas
      .map((row) => {
        const cli = byCli.get(row.codcli);
        return `
          <tr>
            <td>${escapeHtml(row.codventa)}</td>
            <td>${escapeHtml(cli ? cli.nombres_apellido : row.codcli)}</td>
            <td>${escapeHtml(row.fechaventa)}</td>
            <td><span class="${getEstadoBadgeClass(row.estado)}">${escapeHtml(row.estado || "-")}</span></td>
            <td class="text-end">
              <div class="row-actions">
                <button class="btn-icon btn-edit" data-action="edit" data-table="ventas" data-id="${escapeHtml(row.codventa)}"><i class="bi bi-pencil"></i></button>
                <button class="btn-icon btn-delete" data-action="delete" data-table="ventas" data-id="${escapeHtml(row.codventa)}"><i class="bi bi-trash"></i></button>
              </div>
            </td>
          </tr>`;
      })
      .join("");
  }

  function renderDetventas() {
    const byProd = new Map(state.productos.map((p) => [p.codprod, p]));
    const body = $("detventas-body");
    body.innerHTML = state.detventas
      .map((row) => {
        const p = byProd.get(row.codprod);
        return `
          <tr>
            <td>${escapeHtml(row.codventa)}</td>
            <td>${escapeHtml(p ? p.descripcion : row.codprod)}</td>
            <td>${escapeHtml(row.cantidad)}</td>
            <td>${formatMoney(row.subtotal)}</td>
            <td class="text-end">
              <div class="row-actions">
                <button class="btn-icon btn-edit" data-action="edit-det" data-id="${escapeHtml(`${row.codventa}::${row.codprod}`)}"><i class="bi bi-pencil"></i></button>
                <button class="btn-icon btn-delete" data-action="delete-det" data-id="${escapeHtml(`${row.codventa}::${row.codprod}`)}"><i class="bi bi-trash"></i></button>
              </div>
            </td>
          </tr>`;
      })
      .join("");
  }

  function renderResumen() {
    const byCli = new Map(state.clientes.map((c) => [c.codcli, c]));
    const byProd = new Map(state.productos.map((p) => [p.codprod, p]));
    const clienteFilter = $("resumen-filter-cliente") ? $("resumen-filter-cliente").value : "ALL";
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
                  <span>${escapeHtml(prod ? prod.descripcion : d.codprod)} <small class="text-muted">x${escapeHtml(d.cantidad)}</small></span>
                  <span>${formatMoney(d.subtotal)}</span>
                </li>`;
            })
            .join("")
        : '<li class="text-muted py-1">Sin líneas en detalle</li>';

      return `
        <article class="resumen-card">
          <div class="resumen-title mb-2">
            <div>
              <strong>${escapeHtml(venta.codventa)}</strong>
              <div class="small text-muted">${escapeHtml(cliente ? cliente.nombres_apellido : venta.codcli)}</div>
            </div>
            <div class="${getEstadoTagClass(venta.estado)}">${escapeHtml(venta.fechaventa || "")} - ${escapeHtml(venta.estado || "-")}</div>
          </div>
          <ul class="list-unstyled mb-2">${lines}</ul>
          <div class="d-flex justify-content-end fw-bold">Total: ${formatMoney(total)}</div>
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
    if ($("resumen-consumo-label")) $("resumen-consumo-label").textContent = `${clienteLabel} - ${periodoLabel} - ${estadoLabel}`;

    container.innerHTML = cards.length ? cards.join("") : '<p class="text-muted">Aún no hay ventas registradas.</p>';
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
    renderReportCharts();
  }

  function resetForm(section) {
    state.editing[section] = null;
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
    }
    if (section === "productos") {
      $("producto-codprod").value = row.codprod;
      $("producto-descripcion").value = row.descripcion;
      $("producto-marca").value = row.marca;
      $("producto-precio").value = row.precio;
      $("producto-stock").value = row.stock;
      $("producto-fecha-vencimiento").value = row.fecha_vencimiento;
    }
    if (section === "ventas") {
      $("venta-codventa").value = row.codventa;
      setVentaClienteInputByCode(row.codcli);
      $("venta-fechaventa").value = row.fechaventa;
      $("venta-estado").value = row.estado || "PENDIENTE";
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
    }
  }

  async function upsertSimple(table, section, payload) {
    await withSessionRetry(async () => {
      const current = state.editing[section];
      if (!current) {
        payload.id = await nextId(table);
        const { error } = await db.from(table).insert([payload]);
        if (error) throw error;
        showToast(`${section} registrado correctamente`);
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
          throw new Error("No se pudo actualizar. Tu sesion pudo expirar, vuelve a ingresar.");
        }
        showToast(`${section} actualizado correctamente`);
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
        throw new Error("No se pudo eliminar. Tu sesion pudo expirar, vuelve a ingresar.");
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
        throw new Error("No se pudo eliminar. Tu sesion pudo expirar, vuelve a ingresar.");
      }
    });
    showToast("Detalle eliminado");
    await loadAllData();
  }

  function activateSection(section) {
    document.querySelectorAll(".module-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.section === section);
    });
    document.querySelectorAll(".module-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `section-${section}`);
    });
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
    document.querySelectorAll(".module-tab").forEach((btn) => {
      btn.addEventListener("click", () => activateSection(btn.dataset.section));
    });

    document.querySelectorAll("[data-reset]").forEach((btn) => {
      btn.addEventListener("click", () => resetForm(btn.dataset.reset));
    });

    $("register-btn").addEventListener("click", async () => {
      try {
        const email = $("correo").value.trim();
        const password = $("clave").value.trim();
        await register(email, password);
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
        await login(email, password);
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
        await ensureActiveSession({ forceRefresh: true });
        await upsertSimple("clientes", "clientes", {
          codcli: $("cliente-codcli").value.trim(),
          nombres_apellido: $("cliente-nombre").value.trim(),
          area: $("cliente-area").value.trim(),
          user_id: state.user.id
        });
      } catch (err) {
        showToast(err.message, true);
      }
    });

    $("productos-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
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
      } catch (err) {
        showToast(err.message, true);
      }
    });

    $("ventas-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await ensureActiveSession({ forceRefresh: true });
        const codcli = getVentaClienteCode($("venta-codcli").value);
        if (!codcli) {
          throw new Error("Selecciona un cliente valido de la lista.");
        }
        setVentaClienteInputByCode(codcli);
        await upsertSimple("ventas", "ventas", {
          codventa: $("venta-codventa").value.trim(),
          codcli,
          fechaventa: $("venta-fechaventa").value,
          estado: $("venta-estado").value,
          user_id: state.user.id
        });
      } catch (err) {
        showToast(err.message, true);
      }
    });

    $("detventas-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
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
              throw new Error("No se pudo actualizar. Tu sesion pudo expirar, vuelve a ingresar.");
            }
            showToast("Detalle actualizado");
          });
        }
        resetForm("detventas");
        await loadAllData();
      } catch (err) {
        showToast(err.message, true);
      }
    });

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

    $("resumen-filter-cliente").addEventListener("change", () => {
      renderResumen();
    });

    $("resumen-filter-periodo").addEventListener("change", () => {
      renderResumen();
    });

    $("resumen-filter-estado").addEventListener("change", () => {
      renderResumen();
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
      } catch (err) {
        showToast(err.message, true);
      }
    });

    db.auth.onAuthStateChange(async (event, session) => {
      if (!session) {
        clearAppState();
        showAuth();
        if (event !== "INITIAL_SESSION") {
          setAuthStatus("Tu sesion finalizo. Vuelve a ingresar.", true);
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
