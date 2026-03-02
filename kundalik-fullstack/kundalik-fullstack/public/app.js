/* Fullstack frontend:
   - Login -> POST /api/login
   - All data from backend (SQLite)
   - Teachers see only their subjects
*/

const SUBJECTS = ["С айти","Немецский язык","Англисйский","Программирование","Матиматика","Биология","Химия"];
const MONTHS_RU = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

function fmtDateISO(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function daysInMonth(year, monthIndex){
  return new Date(year, monthIndex+1, 0).getDate();
}
function clampMonth(date){ return new Date(date.getFullYear(), date.getMonth(), 1); }

function isAbsence(v){
  if(!v) return false;
  const s = String(v).trim().toUpperCase();
  return s === "П" || s === "Н";
}
function isLate(v){
  if(!v) return false;
  return String(v).trim().toUpperCase() === "О";
}
function isNumericGrade(v){
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10;
}
function normalizeGrade(v){
  if(!v) return "";
  const s = String(v).trim();
  const up = s.toUpperCase();
  if(up === "P") return "П";
  if(up === "O") return "О";
  if(up === "H") return "Н";
  if(up === "П" || up === "О" || up === "Н") return up;
  const n = Number(s);
  if(Number.isFinite(n) && Number.isInteger(n)) return String(n);
  return s;
}

function escapeHtml(s){
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
function escapeAttr(s){
  return escapeHtml(s).replaceAll("'","&#39;");
}
function weekDayShort(d){ return ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"][d] || ""; }
function weekDayName(d){ return ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"][d] || ""; }

const API = {
  tokenKey: "sj_token",
  get token(){ return localStorage.getItem(this.tokenKey) || ""; },
  set token(v){ if(v) localStorage.setItem(this.tokenKey, v); else localStorage.removeItem(this.tokenKey); },

  async req(path, {method="GET", body=null} = {}){
    const headers = { "Content-Type": "application/json" };
    if(this.token) headers["Authorization"] = `Bearer ${this.token}`;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
    if(!res.ok){
      const t = await res.text().catch(()=> "");
      throw new Error(t || `HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  },
  login(login, password){ return this.req("/api/login", {method:"POST", body:{login,password}}); },
  me(){ return this.req("/api/me"); },
  classes(){ return this.req("/api/classes"); },
  gradebook(q){ 
    const usp = new URLSearchParams(q).toString();
    return this.req(`/api/gradebook?${usp}`);
  },
  setGrade(payload){ return this.req("/api/grades", {method:"PUT", body:payload}); },
  setTopic(payload){ return this.req("/api/topics", {method:"PUT", body:payload}); },
  addClass(name){ return this.req("/api/classes", {method:"POST", body:{name}}); },
  addStudent(classId, name){ return this.req(`/api/classes/${classId}/students`, {method:"POST", body:{name}}); },
  delStudent(studentId){ return this.req(`/api/students/${studentId}`, {method:"DELETE"}); },
  blacklist(){ return this.req("/api/blacklist"); },
  unlock(studentId){ return this.req(`/api/blacklist/${studentId}/unlock`, {method:"POST"}); },
};

function app(){
  const appEl = document.getElementById("app");

  let session = null; // {user}
  let classes = [];
  let currentClassId = null;
  let currentSubject = SUBJECTS[0];
  let currentMonth = clampMonth(new Date());
  let activeDay = null;

  // in-memory view model for current screen
  let vm = {
    students: [],
    grades: {},   // studentId -> {dateISO: value}
    topics: {},   // dateISO -> topic
    audit: [],
    lockedStudents: new Set(), // studentId
    subjectAllowed: [],
  };

  // toast
  let toastTimer = null;
  function toast(msg){
    clearTimeout(toastTimer);
    let el = document.getElementById("toast");
    if(!el){
      el = document.createElement("div");
      el.id = "toast";
      el.style.position="fixed";
      el.style.left="50%";
      el.style.bottom="16px";
      el.style.transform="translateX(-50%)";
      el.style.padding="10px 12px";
      el.style.border="1px solid #dfe3ee";
      el.style.background="#fff";
      el.style.borderRadius="8px";
      el.style.boxShadow="0 8px 18px rgba(16,24,40,.10)";
      el.style.zIndex="100";
      el.style.fontSize="13px";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity="1";
    toastTimer = setTimeout(()=>{ el.style.opacity="0"; }, 1800);
  }

  // modal
  function openModal({title, body, actions, onAfterOpen, wide}){
    const modal = document.getElementById("modal");
    modal.setAttribute("aria-hidden","false");
    const card = modal.querySelector(".modalCard");
    card.style.width = wide ? "min(1100px, 100%)" : "min(560px, 100%)";
    document.getElementById("modalTitle").textContent = title;
    document.getElementById("modalBody").innerHTML = body;

    const actionsEl = document.getElementById("modalActions");
    actionsEl.innerHTML = "";
    for(const a of actions || []){
      const b = document.createElement("button");
      b.className = a.kind || "btn";
      b.textContent = a.text;
      b.onclick = a.onClick;
      actionsEl.appendChild(b);
    }
    modal.onclick = (e)=>{ if(e.target === modal) closeModal(); };
    window.onkeydown = (e)=>{ if(e.key === "Escape") closeModal(); };
    setTimeout(()=> onAfterOpen && onAfterOpen(), 0);
  }
  function closeModal(){
    const modal = document.getElementById("modal");
    modal.setAttribute("aria-hidden","true");
    window.onkeydown = null;
  }

  function mountLogin(){
    appEl.innerHTML = "";
    const tpl = document.getElementById("tpl-login").content.cloneNode(true);
    appEl.appendChild(tpl);

    const form = document.getElementById("loginForm");
    form.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const fd = new FormData(form);
      const login = String(fd.get("login")||"").trim();
      const password = String(fd.get("password")||"").trim();
      try{
        const res = await API.login(login, password);
        API.token = res.token;
        await bootstrap();
      }catch(err){
        toast("Неверный логин или пароль");
      }
    });
  }

  async function bootstrap(){
    try{
      session = await API.me();
    }catch(e){
      API.token = "";
      session = null;
      mountLogin();
      return;
    }
    await loadClasses();
    mountShell();
  }

  async function loadClasses(){
    classes = await API.classes();
    currentClassId = currentClassId || classes[0]?.id || null;
  }

  function mountShell(){
    appEl.innerHTML = "";
    const tpl = document.getElementById("tpl-shell").content.cloneNode(true);
    appEl.appendChild(tpl);

    document.getElementById("userChip").innerHTML =
      `<span class="dot"></span><span>${escapeHtml(session.display)}</span>`;

    document.getElementById("btnLogout").onclick = ()=>{
      API.token = "";
      session = null;
      mountLogin();
    };

    const btnAdmin = document.getElementById("btnAdmin");
    const btnAddStudent = document.getElementById("btnAddStudent");
    if(session.role === "admin"){
      btnAdmin.style.display = "";
      btnAddStudent.style.display = "";
      btnAdmin.onclick = ()=> openAdmin();
      btnAddStudent.onclick = ()=> promptAddStudent();
    }

    const classSelect = document.getElementById("classSelect");
    classSelect.onchange = async ()=>{
      currentClassId = classSelect.value;
      activeDay = null;
      await refreshGradebook();
      renderAll();
    };

    const subjectSelect = document.getElementById("subjectSelect");
    if(session.role === "admin"){
      renderSubjectOptions(subjectSelect, SUBJECTS);
      subjectSelect.onchange = async ()=>{ currentSubject = subjectSelect.value; activeDay = null; await refreshGradebook(); renderAll(); };
    } else {
      const allowed = session.subjects || [];
      renderSubjectOptions(subjectSelect, allowed);
      currentSubject = allowed[0] || currentSubject;
      subjectSelect.onchange = async ()=>{ currentSubject = subjectSelect.value; activeDay = null; await refreshGradebook(); renderAll(); };
    }

    document.getElementById("btnPrevMonth").onclick = async ()=>{
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth()-1, 1);
      activeDay = null;
      await refreshGradebook();
      renderAll();
    };
    document.getElementById("btnNextMonth").onclick = async ()=>{
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth()+1, 1);
      activeDay = null;
      await refreshGradebook();
      renderAll();
    };

    document.getElementById("btnSaveTopic").onclick = async ()=>{
      if(activeDay === null){ toast("Сначала выберите день"); return; }
      const dateISO = fmtDateISO(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), activeDay));
      const topic = (document.getElementById("topicText").value || "").trim();
      try{
        await API.setTopic({ classId: currentClassId, subject: currentSubject, date: dateISO, topic });
        vm.topics[dateISO] = topic;
        toast("Тема сохранена");
        renderTopicBox();
      }catch(e){
        toast("Ошибка сохранения темы");
      }
    };
    document.getElementById("btnEditTopic").onclick = ()=>{
      document.getElementById("topicEdit").style.display = "";
      document.getElementById("topicView").style.display = "none";
    };

    // initial render
    (async ()=>{
      await refreshGradebook();
      renderAll();
    })();
  }

  function renderClassOptions(select){
    select.innerHTML = classes.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  }
  function renderSubjectOptions(select, arr){
    select.innerHTML = arr.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  }

  async function refreshGradebook(){
    if(!currentClassId) return;
    const y = currentMonth.getFullYear();
    const m = currentMonth.getMonth()+1;
    const data = await API.gradebook({ classId: currentClassId, subject: currentSubject, year: String(y), month: String(m) });
    vm.students = data.students;
    vm.grades = data.grades;
    vm.topics = data.topics;
    vm.audit = data.audit;
    vm.lockedStudents = new Set((data.lockedStudentIds || []).map(String));
  }

  function renderAll(){
    // update selects
    renderClassOptions(document.getElementById("classSelect"));
    document.getElementById("classSelect").value = currentClassId;

    const subjectSelect = document.getElementById("subjectSelect");
    if(session.role === "admin"){
      renderSubjectOptions(subjectSelect, SUBJECTS);
    } else {
      renderSubjectOptions(subjectSelect, session.subjects || []);
    }
    subjectSelect.value = currentSubject;

    document.getElementById("monthTitle").textContent =
      `${MONTHS_RU[currentMonth.getMonth()]} ${currentMonth.getFullYear()}`;

    renderGradeTable();
    renderTopicBox();
    renderAudit();
    renderLockNote();
  }

  function renderLockNote(){
    document.getElementById("lockNote").textContent =
      "Если у ученика пропусков (П/Н) больше 2 (по всем предметам), он попадает в черный список. Учителям редактирование запрещено.";
  }

  function calcStatsForMonth(year, monthIndex){
    const dim = daysInMonth(year, monthIndex);
    const res = {};
    for(const st of vm.students){
      let abs=0, late=0, sum=0, cnt=0, marked=0;
      const row = vm.grades[String(st.id)] || {};
      for(let day=1; day<=dim; day++){
        const date = fmtDateISO(new Date(year, monthIndex, day));
        const v = row[date];
        if(v === undefined || v === null || String(v).trim()==="") continue;
        marked++;
        if(isAbsence(v)) abs++;
        else if(isLate(v)) late++;
        else if(isNumericGrade(v)){ sum += Number(v); cnt++; }
      }
      const avg = cnt ? (sum/cnt) : 0;
      const avgPct = cnt ? Math.round((avg/10)*100) : 0;
      const attendancePct = marked ? Math.round(((marked-abs)/marked)*100) : 0;
      res[String(st.id)] = { absences: abs, lates: late, avgPct, attendancePct };
    }
    return res;
  }

  function renderGradeTable(){
    const table = document.getElementById("gradeTable");
    const year = currentMonth.getFullYear();
    const monthIndex = currentMonth.getMonth();
    const dim = daysInMonth(year, monthIndex);
    const stats = calcStatsForMonth(year, monthIndex);

    let thead = `<tr>
      <th>Ученик</th>
      <th>Статистика (месяц)</th>
      ${Array.from({length: dim}).map((_,i)=>{
        const day = i+1;
        const d = new Date(year, monthIndex, day);
        const wd = d.getDay();
        const cls2 = (day===activeDay) ? "dayActive" : "";
        return `<th class="${cls2}" data-day="${day}" title="${weekDayName(wd)}">${day}<div class="muted small">${weekDayShort(wd)}</div></th>`;
      }).join("")}
    </tr>`;

    let rows = "";
    for(const st of vm.students){
      const stId = String(st.id);
      const locked = vm.lockedStudents.has(stId) && session.role !== "admin";
      const rowRed = vm.lockedStudents.has(stId) ? "rowRed" : "";
      const stStats = stats[stId] || {absences:0,lates:0,avgPct:0,attendancePct:0};

      const statBadge = `
        <div class="badge ${vm.lockedStudents.has(stId) ? "red" : (stStats.absences>2 ? "yellow":"green")}">
          <span>П/Н: <b>${stStats.absences}</b></span>
          <span>О: <b>${stStats.lates}</b></span>
          <span>Усп.: <b>${stStats.avgPct}%</b></span>
          <span>Посещ.: <b>${stStats.attendancePct}%</b></span>
        </div>
      `;

      const rowGrades = vm.grades[stId] || {};
      let cells = "";
      for(let day=1; day<=dim; day++){
        const dateISO = fmtDateISO(new Date(year, monthIndex, day));
        const v = rowGrades[dateISO] ?? "";
        const clsCell = ["cell"];
        if(day===activeDay) clsCell.push("dayActive");
        if(locked) clsCell.push("locked");
        cells += `<td class="${clsCell.join(" ")}" data-st="${stId}" data-day="${day}" data-date="${dateISO}">${escapeHtml(String(v))}</td>`;
      }

      rows += `<tr class="${rowRed}">
        <td>${escapeHtml(st.name)}</td>
        <td>${statBadge}</td>
        ${cells}
      </tr>`;
    }

    table.innerHTML = thead + rows;

    table.querySelectorAll("th[data-day]").forEach(th=>{
      th.addEventListener("click", ()=>{
        activeDay = Number(th.dataset.day);
        renderGradeTable();
        renderTopicBox();
      });
    });

    table.querySelectorAll("td.cell").forEach(td=>{
      td.addEventListener("click", ()=>{
        activeDay = Number(td.dataset.day);
        renderGradeTable();
        renderTopicBox();

        const stId = String(td.dataset.st);
        if(vm.lockedStudents.has(stId) && session.role !== "admin"){
          toast("Ученик в черном списке. Только админ может разрешить.");
          return;
        }
        editGrade(stId, td.dataset.date);
      });
    });
  }

  function renderTopicBox(){
    const card = document.getElementById("topicCard");
    if(activeDay === null){
      card.style.display = "none";
      return;
    }
    card.style.display = "";

    const dateISO = fmtDateISO(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), activeDay));
    document.getElementById("topicDateLabel").textContent = dateISO;

    const topic = (vm.topics[dateISO] || "").trim();
    const view = document.getElementById("topicView");
    const edit = document.getElementById("topicEdit");
    const txt = document.getElementById("topicText");

    if(!topic){
      view.style.display = "none";
      edit.style.display = "";
      txt.value = "";
      return;
    }
    view.textContent = topic;
    view.style.display = "";
    edit.style.display = "none";
    txt.value = topic;
  }

  function renderAudit(){
    const card = document.getElementById("auditCard");
    const list = document.getElementById("auditList");
    const recent = (vm.audit || []).slice(0, 12);
    if(!recent.length){
      card.style.display = "none";
      return;
    }
    card.style.display = "";
    list.innerHTML = recent.map(a=>{
      const when = new Date(a.at);
      return `<div class="audit">
        <div class="top"><span>${escapeHtml(a.user)}</span><span>${when.toLocaleString()}</span></div>
        <div class="mid"><b>${escapeHtml(a.studentName)}</b> • ${escapeHtml(a.date)} • ${escapeHtml(a.subject)}: <b>${escapeHtml(a.from)}</b> → <b>${escapeHtml(a.to)}</b></div>
        <div class="muted small">Комментарий: ${escapeHtml(a.comment || "—")}</div>
      </div>`;
    }).join("");
  }

  function editGrade(studentId, dateISO){
    const st = vm.students.find(s=>String(s.id)===String(studentId));
    const prev = (vm.grades[String(studentId)] || {})[dateISO] ?? "";

    openModal({
      title: `Оценка • ${st?.name || studentId} • ${dateISO}`,
      body: `
        <div class="stack" style="gap:10px; margin-top:8px">
          <div class="muted">Разрешено: <b>1–10</b>, или <b>П</b>, <b>О</b>, <b>Н</b></div>
          <label class="field">
            <span>Значение</span>
            <input id="gradeInput" value="${escapeAttr(String(prev))}" placeholder="например: 9 или П" />
          </label>
          <label class="field" id="commentField" style="display:none">
            <span>Комментарий (почему меняете)</span>
            <input id="commentInput" placeholder="например: исправил после пересдачи" />
          </label>
        </div>
      `,
      actions: [
        { text:"Отмена", kind:"btn", onClick: closeModal },
        { text:"Сохранить", kind:"btn primary", onClick: async ()=>{
          const valRaw = document.getElementById("gradeInput").value.trim();
          const val = normalizeGrade(valRaw);

          // clear
          if(val === ""){
            try{
              await API.setGrade({ classId: currentClassId, subject: currentSubject, studentId, date: dateISO, value: "" });
              if(vm.grades[String(studentId)]) delete vm.grades[String(studentId)][dateISO];
              toast("Удалено");
              closeModal();
              await refreshGradebook();
              renderAll();
            }catch(e){
              toast("Ошибка удаления");
            }
            return;
          }

          const ok = isNumericGrade(val) || isAbsence(val) || isLate(val);
          if(!ok){ toast("Неверное значение. Только 1–10, П, О, Н."); return; }

          const changing = String(prev).trim() !== String(val).trim();
          const isReplacingExisting = changing && String(prev).trim() !== "" && String(val).trim() !== "";
          const comment = isReplacingExisting ? (document.getElementById("commentInput")?.value || "").trim() : "";

          if(isReplacingExisting && !comment){
            toast("Нужно указать комментарий к изменению");
            return;
          }

          try{
            await API.setGrade({ classId: currentClassId, subject: currentSubject, studentId, date: dateISO, value: val, comment });
            toast("Сохранено");
            closeModal();
            await refreshGradebook();
            renderAll();
          }catch(e){
            toast(String(e.message || "Ошибка сохранения"));
          }
        }},
      ],
      onAfterOpen: ()=>{
        const inp = document.getElementById("gradeInput");
        const cField = document.getElementById("commentField");
        const cInp = document.getElementById("commentInput");
        const update = ()=>{
          const val = normalizeGrade(inp.value.trim());
          const changing = String(prev).trim() !== String(val).trim();
          const need = changing && String(prev).trim() !== "" && String(val).trim() !== "" && val !== "";
          cField.style.display = need ? "" : "none";
          if(!need && cInp) cInp.value = "";
        };
        inp.addEventListener("input", update);
        update();
        inp.focus(); inp.select();
      }
    });
  }

  // ---------- admin ----------
  function openAdmin(){
    openModal({
      title: "Админ-панель",
      body: `<div id="adminRoot"></div>`,
      actions: [{ text:"Закрыть", kind:"btn", onClick: closeModal }],
      wide:true,
      onAfterOpen: async ()=>{
        const root = document.getElementById("adminRoot");
        const tpl = document.getElementById("tpl-admin").content.cloneNode(true);
        root.appendChild(tpl);

        const classForm = document.getElementById("classForm");
        const classList = document.getElementById("classList");
        const blackList = document.getElementById("blackList");
        const userList = document.getElementById("userList");
        const studentsList = document.getElementById("studentsList");

        userList.textContent = (await API.req("/api/users")).map(u=>`${u.login} — ${u.role} — ${u.subject}`).join("\n");

        classForm.onsubmit = async (e)=>{
          e.preventDefault();
          const fd = new FormData(classForm);
          const name = String(fd.get("className")||"").trim();
          if(!name) return;
          await API.addClass(name);
          await loadClasses();
          classForm.reset();
          toast("Класс добавлен");
          await refreshGradebook();
          renderAll();
          await renderAdminLists(classList, studentsList, blackList);
        };

        await renderAdminLists(classList, studentsList, blackList);
      }
    });
  }

  async function renderAdminLists(classList, studentsList, blackList){
    classList.innerHTML = classes.map(c=>{
      const isCurrent = String(c.id) === String(currentClassId);
      return `<div class="item">
        <div class="meta">
          <div class="name">${escapeHtml(c.name)} ${isCurrent ? '<span class="muted small">(открыт)</span>' : ""}</div>
          <div class="sub">Ученики: ${c.studentCount || 0}</div>
        </div>
        <div class="actions">
          <button class="btn" data-act="open" data-id="${c.id}">Открыть</button>
        </div>
      </div>`;
    }).join("");

    classList.querySelectorAll("button[data-act='open']").forEach(btn=>{
      btn.onclick = async ()=>{
        currentClassId = btn.dataset.id;
        activeDay = null;
        await refreshGradebook();
        renderAll();
        toast("Класс открыт");
        await renderAdminLists(classList, studentsList, blackList);
      };
    });

    // students list (current)
    studentsList.innerHTML = vm.students.map(st=>{
      return `<div class="item">
        <div class="meta">
          <div class="name">${escapeHtml(st.name)}</div>
          <div class="sub">ID: <span class="mono small">${escapeHtml(st.id)}</span></div>
        </div>
        <div class="actions">
          <button class="btn danger" data-act="del" data-id="${st.id}">Удалить</button>
        </div>
      </div>`;
    }).join("") || `<div class="muted">В этом классе пока нет учеников.</div>`;

    studentsList.querySelectorAll("button[data-act='del']").forEach(btn=>{
      btn.onclick = ()=>{
        const id = btn.dataset.id;
        const st = vm.students.find(s=>String(s.id)===String(id));
        openModal({
          title: "Удалить ученика",
          body: `Удалить <b>${escapeHtml(st?.name || id)}</b>? Все оценки удалятся.`,
          actions: [
            {text:"Отмена", kind:"btn", onClick: closeModal},
            {text:"Удалить", kind:"btn danger", onClick: async ()=>{
              await API.delStudent(id);
              toast("Удалено");
              closeModal();
              await refreshGradebook();
              renderAll();
              // reopen admin for convenience
              openAdmin();
            }}
          ]
        });
      };
    });

    // blacklist
    const bl = await API.blacklist();
    if(!bl.length){
      blackList.innerHTML = `<div class="muted">Черный список пуст.</div>`;
    } else {
      blackList.innerHTML = bl.map(it=>{
        return `<div class="item">
          <div class="meta">
            <div class="name">${escapeHtml(it.studentName)}</div>
            <div class="sub">Класс: ${escapeHtml(it.className)} • ${escapeHtml(it.reason)} • ${new Date(it.lockedAt).toLocaleString()}</div>
          </div>
          <div class="actions">
            <button class="btn primary" data-act="unlock" data-id="${it.studentId}">Разрешить</button>
          </div>
        </div>`;
      }).join("");
      blackList.querySelectorAll("button[data-act='unlock']").forEach(btn=>{
        btn.onclick = async ()=>{
          await API.unlock(btn.dataset.id);
          toast("Разрешено");
          await refreshGradebook();
          renderAll();
          await renderAdminLists(classList, studentsList, blackList);
        };
      });
    }
  }

  function promptAddStudent(){
    openModal({
      title: "Добавить ученика",
      body: `
        <div class="stack" style="gap:10px; margin-top:8px">
          <label class="field">
            <span>ФИО ученика</span>
            <input id="studentName" placeholder="Например: Ибрагимов Нурбек" />
          </label>
        </div>
      `,
      actions: [
        {text:"Отмена", kind:"btn", onClick: closeModal},
        {text:"Добавить", kind:"btn primary", onClick: async ()=>{
          const name = (document.getElementById("studentName").value || "").trim();
          if(!name){ toast("Введите ФИО"); return; }
          await API.addStudent(currentClassId, name);
          closeModal();
          toast("Ученик добавлен");
          await refreshGradebook();
          renderAll();
        }}
      ],
      onAfterOpen: ()=> document.getElementById("studentName").focus()
    });
  }

  // boot
  if(API.token){
    bootstrap();
  } else {
    mountLogin();
  }
}
document.addEventListener("DOMContentLoaded", app);
