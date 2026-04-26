(function () {
  const config = window.SUPABASE_CONFIG || {};
  const supabaseUrl = config.url;
  const supabaseKey = config.anonKey;

  if (!supabaseUrl || !supabaseKey) {
    alert("Falta configurar Supabase. Crea config.js basado en config.example.js");
    return;
  }

  const db = supabase.createClient(supabaseUrl, supabaseKey);
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

  function syncSelects() {
    setOptions($("venta-codcli"), state.clientes, "codcli", (c) => `${c.codcli} - ${c.nombres_apellido}`);
    setOptions($("detventa-codventa"), state.ventas, "codventa", (v) => `${v.codventa} - ${v.fechaventa || ""}`);
    setOptions($("detventa-codprod"), state.productos, "codprod", (p) => `${p.codprod} - ${p.descripcion}`);
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
              <button class="btn-icon" data-action="edit" data-table="clientes" data-id="${escapeHtml(row.codcli)}"><i class="bi bi-pencil"></i></button>
              <button class="btn-icon" data-action="delete" data-table="clientes" data-id="${escapeHtml(row.codcli)}"><i class="bi bi-trash"></i></button>
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
              <button class="btn-icon" data-action="edit" data-table="productos" data-id="${escapeHtml(row.codprod)}"><i class="bi bi-pencil"></i></button>
              <button class="btn-icon" data-action="delete" data-table="productos" data-id="${escapeHtml(row.codprod)}"><i class="bi bi-trash"></i></button>
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
            <td>${escapeHtml(row.estado || "-")}</td>
            <td class="text-end">
              <div class="row-actions">
                <button class="btn-icon" data-action="edit" data-table="ventas" data-id="${escapeHtml(row.codventa)}"><i class="bi bi-pencil"></i></button>
                <button class="btn-icon" data-action="delete" data-table="ventas" data-id="${escapeHtml(row.codventa)}"><i class="bi bi-trash"></i></button>
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
                <button class="btn-icon" data-action="edit-det" data-id="${escapeHtml(`${row.codventa}::${row.codprod}`)}"><i class="bi bi-pencil"></i></button>
                <button class="btn-icon" data-action="delete-det" data-id="${escapeHtml(`${row.codventa}::${row.codprod}`)}"><i class="bi bi-trash"></i></button>
              </div>
            </td>
          </tr>`;
      })
      .join("");
  }

  function renderResumen() {
    const byCli = new Map(state.clientes.map((c) => [c.codcli, c]));
    const byProd = new Map(state.productos.map((p) => [p.codprod, p]));
    const container = $("resumen-body");
    const cards = state.ventas.map((venta) => {
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
            <div class="linea-tag">${escapeHtml(venta.fechaventa || "")} - ${escapeHtml(venta.estado || "-")}</div>
          </div>
          <ul class="list-unstyled mb-2">${lines}</ul>
          <div class="d-flex justify-content-end fw-bold">Total: ${formatMoney(total)}</div>
        </article>`;
    });

    container.innerHTML = cards.length ? cards.join("") : '<p class="text-muted">Aún no hay ventas registradas.</p>';
  }

  function renderAll() {
    updateStats();
    syncSelects();
    applyAutoCodes();
    renderClientes();
    renderProductos();
    renderVentas();
    renderDetventas();
    renderResumen();
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
      $("venta-fechaventa").value = new Date().toISOString().slice(0, 10);
      $("venta-estado").value = "PENDIENTE";
    }
    if (section === "detventas") {
      $("detventas-form").reset();
      $("detventa-fechaventa").value = new Date().toISOString().slice(0, 10);
    }
    syncSelects();
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

  async function loadAllData() {
    if (!state.user) return;
    const uid = state.user.id;

    const [clientesRes, productosRes, ventasRes, detventasRes] = await Promise.all([
      db.from("clientes").select("*").eq("user_id", uid).order("id", { ascending: false }),
      db.from("productos").select("*").eq("user_id", uid).order("id", { ascending: false }),
      db.from("ventas").select("*").eq("user_id", uid).order("id", { ascending: false }),
      db.from("detventas").select("*").eq("user_id", uid).order("id", { ascending: false })
    ]);

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
      $("venta-codcli").value = row.codcli;
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
      recalcSubtotal();
    }
  }

  async function upsertSimple(table, section, payload) {
    const current = state.editing[section];
    if (!current) {
      payload.id = await nextId(table);
      const { error } = await db.from(table).insert([payload]);
      if (error) throw error;
      showToast(`${section} registrado correctamente`);
    } else {
      const key = TABLE_KEY[section];
      const { error } = await db
        .from(table)
        .update(payload)
        .eq(key, current[key])
        .eq("user_id", state.user.id);
      if (error) throw error;
      showToast(`${section} actualizado correctamente`);
    }
    resetForm(section);
    await loadAllData();
  }

  function recalcSubtotal() {
    const cantidad = Number($("detventa-cantidad").value || 0);
    const precio = Number($("detventa-precio").value || 0);
    $("detventa-subtotal").value = (cantidad * precio).toFixed(2);
  }

  async function handleDelete(table, key, id) {
    const ok = confirm("¿Seguro que deseas eliminar este registro?");
    if (!ok) return;
    const { error } = await db.from(table).delete().eq(key, id).eq("user_id", state.user.id);
    if (error) throw error;
    showToast("Registro eliminado");
    await loadAllData();
  }

  async function handleDeleteDet(composite) {
    const [codventa, codprod] = composite.split("::");
    const ok = confirm("¿Eliminar detalle de venta?");
    if (!ok) return;
    const { error } = await db
      .from("detventas")
      .delete()
      .match({ codventa, codprod, user_id: state.user.id });
    if (error) throw error;
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
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    if (!data.session) {
      state.user = null;
      showAuth();
      return;
    }
    state.user = data.session.user;
    $("user-email").textContent = state.user.email || "Usuario";
    showApp();
    await loadAllData();
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
      await db.auth.signOut();
      state.user = null;
      showAuth();
    });

    $("clientes-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
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
        await upsertSimple("ventas", "ventas", {
          codventa: $("venta-codventa").value.trim(),
          codcli: $("venta-codcli").value,
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
          payload.id = await nextId("detventas");
          const { error } = await db.from("detventas").insert([payload]);
          if (error) throw error;
          showToast("Detalle registrado");
        } else {
          const { error } = await db
            .from("detventas")
            .update(payload)
            .match({
              codventa: current.codventa,
              codprod: current.codprod,
              user_id: state.user.id
            });
          if (error) throw error;
          showToast("Detalle actualizado");
        }
        resetForm("detventas");
        await loadAllData();
      } catch (err) {
        showToast(err.message, true);
      }
    });

    $("detventa-cantidad").addEventListener("input", recalcSubtotal);
    $("detventa-precio").addEventListener("input", recalcSubtotal);

    $("detventa-codprod").addEventListener("change", () => {
      const prod = state.productos.find((p) => p.codprod === $("detventa-codprod").value);
      if (prod) {
        $("detventa-precio").value = prod.precio;
        recalcSubtotal();
      }
    });

    $("detventa-codventa").addEventListener("change", () => {
      const venta = state.ventas.find((v) => v.codventa === $("detventa-codventa").value);
      if (venta) $("detventa-fechaventa").value = venta.fechaventa;
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

    db.auth.onAuthStateChange(async (_event, session) => {
      if (!session) {
        state.user = null;
        showAuth();
        return;
      }
      state.user = session.user;
      $("user-email").textContent = state.user.email || "Usuario";
      showApp();
      await loadAllData();
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
