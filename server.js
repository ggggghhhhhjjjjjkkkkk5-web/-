const express=require("express");
const {Pool}=require("pg");
const crypto=require("crypto");
const path=require("path");
const app=express();
app.set("trust proxy",1);
app.use(express.json({limit:"32kb"}));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?.includes("localhost")?false:{rejectUnauthorized:false}});
const PORT=process.env.PORT||3000;
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;
const SESSION_SECRET=process.env.SESSION_SECRET;
if(!ADMIN_PASSWORD||!SESSION_SECRET) console.warn("Set ADMIN_PASSWORD and SESSION_SECRET in environment.");
const activeTokens=new Set();
const sign=(value)=>crypto.createHmac("sha256",SESSION_SECRET||"missing-secret").update(value).digest("hex");
function requireAdmin(req,res,next){
 const token=(req.headers.authorization||"").replace(/^Bearer /,"");
 if(!token||!activeTokens.has(token)||!token.includes(".")){return res.status(401).json({error:"unauthorized"});}
 const [id,sig]=token.split(".");
 if(sign(id)!==sig)return res.status(401).json({error:"unauthorized"});
 next();
}
async function init(){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS players(
  player_id TEXT PRIMARY KEY, first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_score INT NOT NULL DEFAULT 0,
  best_score INT NOT NULL DEFAULT 0, games INT NOT NULL DEFAULT 0, is_playing BOOLEAN NOT NULL DEFAULT FALSE
 );
 CREATE TABLE IF NOT EXISTS game_events(
  id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS game_settings(
  id INT PRIMARY KEY DEFAULT 1, data JSONB NOT NULL DEFAULT '{"missilePrice":10,"gameTitle":"فرماندهی پدافند","announcement":""}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 INSERT INTO game_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
 `);
}
app.get("/api/health",(req,res)=>res.json({ok:true}));
app.get("/api/config",async(req,res)=>{
 try{const r=await pool.query("SELECT data FROM game_settings WHERE id=1");res.json(r.rows[0]?.data||{});}catch(e){res.status(500).json({error:"config"});}
});
app.post("/api/heartbeat",async(req,res)=>{
 const {playerId,score=0,best=0,playing=false}=req.body||{};
 if(typeof playerId!=="string"||playerId.length<3||playerId.length>100)return res.status(400).json({error:"playerId"});
 const s=Math.max(0,Math.min(100000000,Number(score)||0)),b=Math.max(0,Math.min(100000000,Number(best)||0));
 try{
  await pool.query(`INSERT INTO players(player_id,last_seen,last_score,best_score,games,is_playing)
  VALUES($1,NOW(),$2,$3,0,$4) ON CONFLICT(player_id) DO UPDATE SET last_seen=NOW(),
  last_score=EXCLUDED.last_score,best_score=GREATEST(players.best_score,EXCLUDED.best_score),
  is_playing=EXCLUDED.is_playing`,[playerId,s,b,!!playing]);
  res.json({ok:true});
 }catch(e){res.status(500).json({error:"heartbeat"});}
});
app.get("/api/events",async(req,res)=>{try{const r=await pool.query("SELECT id,title,description,starts_at,ends_at FROM game_events WHERE active=TRUE AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>=NOW()) ORDER BY created_at DESC LIMIT 5");res.json(r.rows);}catch(e){res.status(500).json([]);}});
app.post("/api/game-start",async(req,res)=>{
 const {playerId}=req.body||{};if(typeof playerId!=="string")return res.status(400).end();
 try{await pool.query("UPDATE players SET games=games+1,is_playing=TRUE,last_seen=NOW() WHERE player_id=$1",[playerId]);res.json({ok:true});}catch(e){res.status(500).end();}
});
app.post("/api/admin/login",(req,res)=>{
 const pass=String(req.body?.password||"");
 const a=Buffer.from(pass),b=Buffer.from(ADMIN_PASSWORD||"");
 if(!ADMIN_PASSWORD||a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:"رمز عبور اشتباه است"});
 const id=crypto.randomBytes(24).toString("hex"),token=id+"."+sign(id);activeTokens.add(token);
 res.json({token});
});
app.post("/api/admin/logout",requireAdmin,(req,res)=>{activeTokens.delete((req.headers.authorization||"").replace(/^Bearer /,""));res.json({ok:true});});
app.get("/api/admin/stats",requireAdmin,async(req,res)=>{
 try{
 const [tot,online,today,leaders,events,settings]=await Promise.all([
  pool.query("SELECT COUNT(*)::int AS total, COALESCE(SUM(games),0)::int AS games FROM players"),
  pool.query("SELECT COUNT(*)::int AS count FROM players WHERE last_seen>NOW()-INTERVAL '90 seconds'"),
  pool.query("SELECT COUNT(*)::int AS count FROM players WHERE first_seen>=CURRENT_DATE"),
  pool.query("SELECT player_id,best_score,games,last_seen FROM players ORDER BY best_score DESC LIMIT 30"),
  pool.query("SELECT * FROM game_events ORDER BY created_at DESC LIMIT 30"),
  pool.query("SELECT data,updated_at FROM game_settings WHERE id=1")
 ]);
 res.json({total:tot.rows[0].total,games:tot.rows[0].games,online:online.rows[0].count,today:today.rows[0].count,leaders:leaders.rows,events:events.rows,settings:settings.rows[0]});
 }catch(e){res.status(500).json({error:"stats"});}
});
app.get("/api/admin/players",requireAdmin,async(req,res)=>{
 try{const r=await pool.query("SELECT player_id,first_seen,last_seen,last_score,best_score,games,is_playing FROM players ORDER BY last_seen DESC LIMIT 200");res.json(r.rows);}catch(e){res.status(500).end();}
});
app.put("/api/admin/settings",requireAdmin,async(req,res)=>{
 const data={missilePrice:Math.max(1,Math.min(100000,Number(req.body?.missilePrice)||10)),gameTitle:String(req.body?.gameTitle||"فرماندهی پدافند").slice(0,80),announcement:String(req.body?.announcement||"").slice(0,500)};
 try{await pool.query("UPDATE game_settings SET data=$1,updated_at=NOW() WHERE id=1",[JSON.stringify(data)]);res.json({ok:true,data});}catch(e){res.status(500).end();}
});
app.post("/api/admin/events",requireAdmin,async(req,res)=>{
 const title=String(req.body?.title||"").slice(0,100),description=String(req.body?.description||"").slice(0,500);
 if(!title)return res.status(400).json({error:"عنوان لازم است"});
 try{const r=await pool.query("INSERT INTO game_events(title,description,starts_at,ends_at,active) VALUES($1,$2,$3,$4,true) RETURNING *",[title,description,req.body?.startsAt||null,req.body?.endsAt||null]);res.json(r.rows[0]);}catch(e){res.status(500).end();}
});
app.patch("/api/admin/events/:id",requireAdmin,async(req,res)=>{
 try{const r=await pool.query("UPDATE game_events SET active=$1 WHERE id=$2 RETURNING *",[!!req.body?.active,Number(req.params.id)]);res.json(r.rows[0]||{});}catch(e){res.status(500).end();}
});
app.get("/admin-sw.js",(req,res)=>{res.setHeader("Service-Worker-Allowed","/admin");res.sendFile(path.join(__dirname,"admin-sw.js"));});
app.use(express.static(path.join(__dirname)));
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"admin.html")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
init().then(()=>app.listen(PORT,"0.0.0.0",()=>console.log("Padafand server on "+PORT))).catch(e=>{console.error(e);process.exit(1);});
