/**
 * Fullstack backend (Express + SQLite)
 * - Auth JWT
 * - Role: admin / teacher
 * - Teachers limited to their subject(s)
 * - Grade validation: 1..10 or П/О/Н
 * - If student absences (П/Н) > 2 across ALL subjects => blacklist lock
 */
const path = require("path");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_TO_A_LONG_RANDOM_SECRET";

const db = new Database(path.join(__dirname, "database.sqlite"));

const SUBJECTS = ["С айти","Немецский язык","Англисйский","Программирование","Матиматика","Биология","Химия"];

function initDb(){
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','teacher')),
      subject TEXT NOT NULL -- 'ALL' for admin, or one subject for teachers (simple)
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS grades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      date TEXT NOT NULL, -- YYYY-MM-DD
      value TEXT NOT NULL,
      UNIQUE(student_id, subject, date),
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      date TEXT NOT NULL,
      topic TEXT NOT NULL,
      UNIQUE(class_id, subject, date),
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      user_login TEXT NOT NULL,
      class_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      student_id INTEGER NOT NULL,
      student_name TEXT NOT NULL,
      date TEXT NOT NULL,
      from_value TEXT NOT NULL,
      to_value TEXT NOT NULL,
      comment TEXT NOT NULL,
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      student_id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
    );
  `);
}

function seed(){
  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if(userCount > 0) return;

  const insertUser = db.prepare("INSERT INTO users (login, password_hash, role, subject) VALUES (?,?,?,?)");

  // Admin
  insertUser.run("Nodir", bcrypt.hashSync("Nodir228", 10), "admin", "ALL");

  // 10 teachers (demo)
  const teachers = [
    ["admin1","admin1pass","Матиматика"],
    ["admin2","admin2pass","С айти"],
    ["admin3","admin3pass","Немецский язык"],
    ["admin4","admin4pass","Англисйский"],
    ["admin5","admin5pass","Программирование"],
    ["admin6","admin6pass","Биология"],
    ["admin7","admin7pass","Химия"],
    ["admin8","admin8pass","Матиматика"],
    ["admin9","admin9pass","С айти"],
    ["admin10","admin10pass","Англисйский"],
  ];
  for(const [login, pass, subj] of teachers){
    insertUser.run(login, bcrypt.hashSync(pass, 10), "teacher", subj);
  }

  // Default class + students
  const insClass = db.prepare("INSERT INTO classes (name) VALUES (?)");
  const clsId = insClass.run("7-А").lastInsertRowid;

  const insStudent = db.prepare("INSERT INTO students (class_id, name) VALUES (?,?)");
  insStudent.run(clsId, "Алиев Бахтиёр");
  insStudent.run(clsId, "Каримова Малика");
  insStudent.run(clsId, "Саидов Азиз");
}

function auth(req, res, next){
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if(!m) return res.status(401).send("No token");
  try{
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = payload;
    next();
  }catch(e){
    return res.status(401).send("Bad token");
  }
}

function requireAdmin(req, res, next){
  if(req.user?.role !== "admin") return res.status(403).send("Admin only");
  next();
}

function normalizeGrade(v){
  if(v === null || v === undefined) return "";
  const s = String(v).trim();
  const up = s.toUpperCase();
  if(up === "P") return "П";
  if(up === "O") return "О";
  if(up === "H") return "Н";
  if(up === "П" || up === "О" || up === "Н") return up;
  // numeric
  if(/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
}
function isValidGrade(v){
  if(v === "") return true; // allow clear
  if(v === "П" || v === "О" || v === "Н") return true;
  if(/^\d+$/.test(v)){
    const n = parseInt(v, 10);
    return n >= 1 && n <= 10;
  }
  return false;
}
function isAbsence(v){ return v === "П" || v === "Н"; }

function enforceSubject(req, res, next){
  if(req.user.role === "admin") return next();
  const subject = req.body.subject || req.query.subject;
  if(!subject) return res.status(400).send("No subject");
  if(subject !== req.user.subject) return res.status(403).send("Forbidden subject");
  next();
}

function ensureNotLockedForTeacher(req, res, next){
  if(req.user.role === "admin") return next();
  const studentId = Number(req.body.studentId);
  if(!studentId) return res.status(400).send("No studentId");
  const locked = db.prepare("SELECT locked FROM students WHERE id=?").get(studentId);
  if(!locked) return res.status(404).send("Student not found");
  if(locked.locked) return res.status(403).send("Student is locked (blacklist)");
  next();
}

function recomputeAndLockIfNeeded(studentId){
  // absences across all subjects
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM grades
    WHERE student_id = ?
      AND value IN ('П','Н')
  `).get(studentId);
  const abs = row?.c || 0;

  const st = db.prepare("SELECT id, class_id, name FROM students WHERE id=?").get(studentId);
  if(!st) return;

  if(abs > 2){
    const exists = db.prepare("SELECT student_id FROM blacklist WHERE student_id=?").get(studentId);
    const now = new Date().toISOString();
    if(!exists){
      db.prepare("INSERT INTO blacklist (student_id, class_id, reason, locked_at) VALUES (?,?,?,?)")
        .run(studentId, st.class_id, `Пропусков (П/Н) больше 2: ${abs}`, now);
    }else{
      db.prepare("UPDATE blacklist SET reason=?, locked_at=? WHERE student_id=?")
        .run(`Пропусков (П/Н) больше 2: ${abs}`, now, studentId);
    }
    db.prepare("UPDATE students SET locked=1 WHERE id=?").run(studentId);
  }else{
    // do not auto-unlock; admin must unlock
  }
}

initDb();
seed();

// -------- API --------
app.post("/api/login", (req, res)=>{
  const { login, password } = req.body || {};
  if(!login || !password) return res.status(400).send("Missing login/password");
  const u = db.prepare("SELECT id, login, password_hash, role, subject FROM users WHERE login=?").get(login);
  if(!u) return res.status(401).send("Bad credentials");
  const ok = bcrypt.compareSync(password, u.password_hash);
  if(!ok) return res.status(401).send("Bad credentials");
  const token = jwt.sign({ id: u.id, login: u.login, role: u.role, subject: u.subject }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token });
});

app.get("/api/me", auth, (req, res)=>{
  const u = db.prepare("SELECT id, login, role, subject FROM users WHERE id=?").get(req.user.id);
  if(!u) return res.status(401).send("No user");
  const subjects = u.role === "admin" ? SUBJECTS : [u.subject];
  const display = u.role === "admin" ? `Админ: ${u.login}` : `Учитель: ${u.login} • ${u.subject}`;
  res.json({ id: u.id, login: u.login, role: u.role, subject: u.subject, subjects, display });
});

app.get("/api/users", auth, requireAdmin, (req, res)=>{
  const rows = db.prepare("SELECT login, role, subject FROM users ORDER BY role DESC, login ASC").all();
  res.json(rows);
});

app.get("/api/classes", auth, (req, res)=>{
  const rows = db.prepare(`
    SELECT c.id, c.name,
           (SELECT COUNT(*) FROM students s WHERE s.class_id=c.id) AS studentCount
    FROM classes c
    ORDER BY c.name ASC
  `).all();
  res.json(rows);
});

app.post("/api/classes", auth, requireAdmin, (req, res)=>{
  const name = String(req.body?.name || "").trim();
  if(!name) return res.status(400).send("No name");
  try{
    const r = db.prepare("INSERT INTO classes (name) VALUES (?)").run(name);
    res.json({ id: r.lastInsertRowid, name });
  }catch(e){
    return res.status(400).send("Class exists?");
  }
});

app.post("/api/classes/:id/students", auth, requireAdmin, (req, res)=>{
  const classId = Number(req.params.id);
  const name = String(req.body?.name || "").trim();
  if(!classId || !name) return res.status(400).send("Bad request");
  const cls = db.prepare("SELECT id FROM classes WHERE id=?").get(classId);
  if(!cls) return res.status(404).send("No class");
  const r = db.prepare("INSERT INTO students (class_id, name) VALUES (?,?)").run(classId, name);
  res.json({ id: r.lastInsertRowid, name });
});

app.delete("/api/students/:id", auth, requireAdmin, (req, res)=>{
  const studentId = Number(req.params.id);
  if(!studentId) return res.status(400).send("Bad id");
  db.prepare("DELETE FROM students WHERE id=?").run(studentId);
  res.json({ ok: true });
});

app.get("/api/blacklist", auth, requireAdmin, (req, res)=>{
  const rows = db.prepare(`
    SELECT b.student_id AS studentId,
           s.name AS studentName,
           c.name AS className,
           b.reason AS reason,
           b.locked_at AS lockedAt
    FROM blacklist b
    JOIN students s ON s.id=b.student_id
    JOIN classes c ON c.id=b.class_id
    ORDER BY b.locked_at DESC
  `).all();
  res.json(rows);
});

app.post("/api/blacklist/:studentId/unlock", auth, requireAdmin, (req, res)=>{
  const studentId = Number(req.params.studentId);
  if(!studentId) return res.status(400).send("Bad id");
  db.prepare("DELETE FROM blacklist WHERE student_id=?").run(studentId);
  db.prepare("UPDATE students SET locked=0 WHERE id=?").run(studentId);
  res.json({ ok: true });
});

app.get("/api/gradebook", auth, enforceSubject, (req, res)=>{
  const classId = Number(req.query.classId);
  const subject = String(req.query.subject || "");
  const year = Number(req.query.year);
  const month = Number(req.query.month); // 1..12

  if(!classId || !subject || !year || !month) return res.status(400).send("Missing params");
  if(!SUBJECTS.includes(subject)) return res.status(400).send("Bad subject");

  const cls = db.prepare("SELECT id FROM classes WHERE id=?").get(classId);
  if(!cls) return res.status(404).send("No class");

  const start = `${year}-${String(month).padStart(2,"0")}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const end = `${endYear}-${String(endMonth).padStart(2,"0")}-01`;

  const students = db.prepare("SELECT id, name, locked FROM students WHERE class_id=? ORDER BY name ASC").all(classId);

  const gradeRows = db.prepare(`
    SELECT student_id AS studentId, date, value
    FROM grades
    WHERE class_id=? AND subject=? AND date >= ? AND date < ?
  `).all(classId, subject, start, end);

  const grades = {};
  for(const st of students){
    grades[String(st.id)] = {};
  }
  for(const r of gradeRows){
    if(!grades[String(r.studentId)]) grades[String(r.studentId)] = {};
    grades[String(r.studentId)][r.date] = r.value;
  }

  const topicRows = db.prepare(`
    SELECT date, topic
    FROM topics
    WHERE class_id=? AND subject=? AND date >= ? AND date < ?
  `).all(classId, subject, start, end);
  const topics = {};
  for(const t of topicRows){
    topics[t.date] = t.topic;
  }

  const auditRows = db.prepare(`
    SELECT at, user_login AS user, subject, student_name AS studentName, date,
           from_value AS "from", to_value AS "to", comment
    FROM audits
    WHERE class_id=? AND subject=?
    ORDER BY at DESC
    LIMIT 12
  `).all(classId, subject);

  const lockedStudentIds = students.filter(s=>s.locked).map(s=>String(s.id));
  res.json({ students, grades, topics, audit: auditRows, lockedStudentIds });
});

app.put("/api/topics", auth, enforceSubject, (req, res)=>{
  const classId = Number(req.body.classId);
  const subject = String(req.body.subject || "");
  const date = String(req.body.date || "").trim();
  const topic = String(req.body.topic || "").trim();

  if(!classId || !subject || !date) return res.status(400).send("Bad request");
  if(!SUBJECTS.includes(subject)) return res.status(400).send("Bad subject");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).send("Bad date");

  const cls = db.prepare("SELECT id FROM classes WHERE id=?").get(classId);
  if(!cls) return res.status(404).send("No class");

  // upsert
  const existing = db.prepare("SELECT id FROM topics WHERE class_id=? AND subject=? AND date=?").get(classId, subject, date);
  if(existing){
    db.prepare("UPDATE topics SET topic=? WHERE id=?").run(topic, existing.id);
  }else{
    db.prepare("INSERT INTO topics (class_id, subject, date, topic) VALUES (?,?,?,?)").run(classId, subject, date, topic);
  }
  res.json({ ok: true });
});

app.put("/api/grades", auth, enforceSubject, ensureNotLockedForTeacher, (req, res)=>{
  const classId = Number(req.body.classId);
  const subject = String(req.body.subject || "");
  const studentId = Number(req.body.studentId);
  const date = String(req.body.date || "").trim();
  const value = normalizeGrade(req.body.value);
  const comment = String(req.body.comment || "").trim();

  if(!classId || !subject || !studentId || !date) return res.status(400).send("Bad request");
  if(!SUBJECTS.includes(subject)) return res.status(400).send("Bad subject");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).send("Bad date");
  if(!isValidGrade(value)) return res.status(400).send("Неверное значение. Только 1–10, П, О, Н.");

  const st = db.prepare("SELECT id, name, class_id, locked FROM students WHERE id=?").get(studentId);
  if(!st) return res.status(404).send("Student not found");
  if(st.class_id !== classId) return res.status(400).send("Student not in class");

  // teacher cannot edit locked (already checked), admin can edit all

  const prev = db.prepare("SELECT value FROM grades WHERE student_id=? AND subject=? AND date=?").get(studentId, subject, date);

  const prevVal = prev ? prev.value : "";

  // if replacing existing non-empty with new non-empty => require comment
  if(prevVal && value && prevVal !== value){
    if(!comment) return res.status(400).send("Нужно указать комментарий к изменению");
  }

  const tx = db.transaction(()=>{
    if(value === ""){
      db.prepare("DELETE FROM grades WHERE student_id=? AND subject=? AND date=?").run(studentId, subject, date);
    }else{
      // upsert
      const exists = db.prepare("SELECT id FROM grades WHERE student_id=? AND subject=? AND date=?").get(studentId, subject, date);
      if(exists){
        db.prepare("UPDATE grades SET value=? WHERE id=?").run(value, exists.id);
      }else{
        db.prepare("INSERT INTO grades (class_id, student_id, subject, date, value) VALUES (?,?,?,?,?)")
          .run(classId, studentId, subject, date, value);
      }
    }

    if(String(prevVal) !== String(value)){
      db.prepare(`
        INSERT INTO audits (at, user_login, class_id, subject, student_id, student_name, date, from_value, to_value, comment)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(new Date().toISOString(), req.user.login, classId, subject, studentId, st.name, date, String(prevVal||""), String(value||""), comment || "");
    }

    // recompute lock if needed
    recomputeAndLockIfNeeded(studentId);
  });

  try{
    tx();
    res.json({ ok: true });
  }catch(e){
    res.status(500).send("DB error");
  }
});

// SPA fallback (if you add routes later)
app.get("*", (req, res)=>{
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, ()=>{
  console.log(`Server running: http://localhost:${PORT}`);
});
