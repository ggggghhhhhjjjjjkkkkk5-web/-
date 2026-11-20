const express=require("express");
const {Pool}=require("pg");
const crypto=require("crypto");
const path=require("path");
const app=express();
app.set("trust proxy",1);
app.use(express.json({limit:"32kb"}));
app.use("/api",(req,res,next)=>{res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,PATCH,DELETE,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization");if(req.method==="OPTIONS")return res.sendStatus(204);next();});
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?.includes("localhost")?false:{rejectUnauthorized:false}});
const PORT=process.env.PORT||3000,ADMIN_PASSWORD=process.env.ADMIN_PASSWORD,SESSION_SECRET=process.env.SESSION_SECRET;
const activeTokens=new Set(),sign=v=>crypto.createHmac("sha256",SESSION_SECRET||"missing-secret").update(v).digest("hex");
function requireAdmin(req,res,next){const t=(req.headers.authorization||"").replace(/^Bearer /,"");if(!t||!activeTokens.has(t)||!t.includes("."))return res.status(401).json({error:"unauthorized"});const [id,sig]=t.split(".");if(sign(id)!==sig)return res.status(401).json({error:"unauthorized"});next();}
const defaults={missilePrice:10,gameTitle:"فرماندهی پدافند",announcement:"",rewardPerHit:1,maxErrors:3,startingCoins:0,shopEnabled:true,gameEnabled:true};
async function init(){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS padafand_players(
 player_id TEXT PRIMARY KEY,username TEXT,first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_score INT NOT NULL DEFAULT 0,best_score INT NOT NULL DEFAULT 0,games INT NOT NULL DEFAULT 0,is_playing BOOLEAN NOT NULL DEFAULT FALSE,
 coins INT NOT NULL DEFAULT 0,homing_ammo INT NOT NULL DEFAULT 0,blocked BOOLEAN NOT NULL DEFAULT FALSE,block_reason TEXT NOT NULL DEFAULT '');
 CREATE UNIQUE INDEX IF NOT EXISTS padafand_players_username_uq ON padafand_players(LOWER(username)) WHERE username IS NOT NULL;
 ALTER TABLE padafand_players ADD COLUMN IF NOT EXISTS username TEXT;
 ALTER TABLE padafand_players ADD COLUMN IF NOT EXISTS coins INT NOT NULL DEFAULT 0;
 ALTER TABLE padafand_players ADD COLUMN IF NOT EXISTS homing_ammo INT NOT NULL DEFAULT 0;
 ALTER TABLE padafand_players ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE padafand_players ADD COLUMN IF NOT EXISTS block_reason TEXT NOT NULL DEFAULT '';
 CREATE TABLE IF NOT EXISTS padafand_game_events(id BIGSERIAL PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',starts_at TIMESTAMPTZ,ends_at TIMESTAMPTZ,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS padafand_game_settings(id INT PRIMARY KEY DEFAULT 1,data JSONB NOT NULL DEFAULT '{}'::jsonb,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 INSERT INTO padafand_game_settings(id,data) VALUES(1,$1::jsonb) ON CONFLICT(id) DO NOTHING;
 `,[JSON.stringify(defaults)]);
}
app.get("/api/health",(req,res)=>res.json({ok:true}));
app.get("/api/config",async(req,res)=>{try{const r=await pool.query("SELECT data FROM padafand_game_settings WHERE id=1");res.json({...defaults,...(r.rows[0]?.data||{})});}catch(e){res.status(500).json({error:"config"});}});
app.post("/api/register",async(req,res)=>{
 const playerId=String(req.body?.playerId||""),username=String(req.body?.username||"").trim();
 if(!/^p_[a-zA-Z0-9_-]{8,100}$/.test(playerId)||!/^[\p{L}\p{N}_-]{3,18}$/u.test(username))return res.status(400).json({error:"نام کاربری باید ۳ تا ۱۸ حرف، عدد یا _ و - باشد."});
 try{
  const existing=await pool.query("SELECT player_id,username,coins,homing_ammo,blocked,block_reason FROM padafand_players WHERE player_id=$1",[playerId]);
  if(existing.rowCount){const p=existing.rows[0];if(p.username&&p.username.toLowerCase()!==username.toLowerCase())return res.status(409).json({error:"این دستگاه قبلاً نام کاربری دیگری ثبت کرده است."});if(p.blocked)return res.status(403).json({error:p.block_reason||"دسترسی شما محدود شده است."});return res.json({ok:true,...p});}
  const r=await pool.query("INSERT INTO padafand_players(player_id,username,coins) VALUES($1,$2,$3) RETURNING player_id,username,coins,homing_ammo,blocked,block_reason",[playerId,username,defaults.startingCoins]);
  res.json({ok:true,...r.rows[0]});
 }catch(e){if(e.code==="23505")return res.status(409).json({error:"این نام کاربری قبلاً انتخاب شده است."});res.status(500).json({error:"ثبت نام انجام نشد"});}
});
app.post("/api/heartbeat",async(req,res)=>{
 const {playerId,score=0,best=0,playing=false}=req.body||{};
 if(typeof playerId!=="string"||playerId.length<3||playerId.length>100)return res.status(400).json({error:"playerId"});
 const s=Math.max(0,Math.min(100000000,Number(score)||0)),b=Math.max(0,Math.min(100000000,Number(best)||0));
 try{const r=await pool.query(`UPDATE padafand_players SET last_seen=NOW(),last_score=$2,best_score=GREATEST(best_score,$3),is_playing=$4 WHERE player_id=$1 RETURNING coins,homing_ammo,blocked,block_reason,username`,[playerId,s,b,!!playing]);if(!r.rowCount)return res.status(404).json({error:"ابتدا نام کاربری انتخاب کنید"});if(r.rows[0].blocked)return res.status(403).json({error:r.rows[0].block_reason||"دسترسی شما محدود شده است."});res.json({ok:true,...r.rows[0]});}catch(e){res.status(500).json({error:"heartbeat"});}
});
app.get("/api/leaderboard",async(req,res)=>{try{const r=await pool.query("SELECT username,best_score,games FROM padafand_players WHERE username IS NOT NULL AND blocked=FALSE ORDER BY best_score DESC,last_seen ASC LIMIT 50");res.json(r.rows);}catch(e){res.status(500).json([]);}});
app.post("/api/wallet",async(req,res)=>{
 const {playerId,action}=req.body||{};
 if(typeof playerId!=="string"||!["award","buy"].includes(action))return res.status(400).json({error:"درخواست نامعتبر"});
 try{
  const cfg=await pool.query("SELECT data FROM padafand_game_settings WHERE id=1"),c={...defaults,...(cfg.rows[0]?.data||{})};
  if(action==="buy"&&!c.shopEnabled)return res.status(403).json({error:"فروشگاه موقتاً غیرفعال است"});
  const amount=action==="award"?Math.max(0,Math.min(20,Number(c.rewardPerHit)||0)):Math.max(1,Math.min(100000,Number(c.missilePrice)||10));
  const sql=action==="award"?"UPDATE padafand_players SET coins=coins+$2,last_seen=NOW() WHERE player_id=$1 AND blocked=FALSE RETURNING coins,homing_ammo":"UPDATE padafand_players SET coins=coins-$2,homing_ammo=homing_ammo+1,last_seen=NOW() WHERE player_id=$1 AND blocked=FALSE AND coins>=$2 RETURNING coins,homing_ammo";
  const r=await pool.query(sql,[playerId,amount]);if(!r.rowCount)return res.status(409).json({error:action==="buy"?"سکه کافی نیست یا حساب محدود شده است":"حساب بازیکن پیدا نشد"});res.json({ok:true,...r.rows[0]});
 }catch(e){res.status(500).json({error:"wallet"});}
});
app.get("/api/events",async(req,res)=>{try{const r=await pool.query("SELECT id,title,description,starts_at,ends_at FROM padafand_game_events WHERE active=TRUE AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>=NOW()) ORDER BY created_at DESC LIMIT 5");res.json(r.rows);}catch(e){res.status(500).json([]);}});
app.post("/api/game-start",async(req,res)=>{const {playerId}=req.body||{};try{const r=await pool.query("UPDATE padafand_players SET games=games+1,is_playing=TRUE,last_seen=NOW() WHERE player_id=$1 AND blocked=FALSE",[playerId]);if(!r.rowCount)return res.status(403).json({error:"دسترسی مجاز نیست"});res.json({ok:true});}catch(e){res.status(500).end();}});
app.post("/api/admin/login",(req,res)=>{const pass=String(req.body?.password||""),a=Buffer.from(pass),b=Buffer.from(ADMIN_PASSWORD||"");if(!ADMIN_PASSWORD||a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:"رمز عبور اشتباه است"});const id=crypto.randomBytes(24).toString("hex"),token=id+"."+sign(id);activeTokens.add(token);res.json({token});});
app.post("/api/admin/logout",requireAdmin,(req,res)=>{activeTokens.delete((req.headers.authorization||"").replace(/^Bearer /,""));res.json({ok:true});});
app.get("/api/admin/stats",requireAdmin,async(req,res)=>{try{const [tot,online,today,leaders,events,settings]=await Promise.all([
pool.query("SELECT COUNT(*)::int total,COALESCE(SUM(games),0)::int games FROM padafand_players"),
pool.query("SELECT COUNT(*)::int count FROM padafand_players WHERE last_seen>NOW()-INTERVAL '90 seconds'"),
pool.query("SELECT COUNT(*)::int count FROM padafand_players WHERE first_seen>=CURRENT_DATE"),
pool.query("SELECT player_id,username,best_score,games,last_seen,coins,homing_ammo,blocked FROM padafand_players ORDER BY best_score DESC LIMIT 30"),
pool.query("SELECT * FROM padafand_game_events ORDER BY created_at DESC LIMIT 30"),
pool.query("SELECT data,updated_at FROM padafand_game_settings WHERE id=1")]);
res.json({total:tot.rows[0].total,games:tot.rows[0].games,online:online.rows[0].count,today:today.rows[0].count,leaders:leaders.rows,events:events.rows,settings:{data:{...defaults,...(settings.rows[0]?.data||{})},updated_at:settings.rows[0]?.updated_at}});}catch(e){res.status(500).json({error:"stats"});}});
app.get("/api/admin/players",requireAdmin,async(req,res)=>{try{const r=await pool.query("SELECT player_id,username,first_seen,last_seen,last_score,best_score,games,is_playing,coins,homing_ammo,blocked,block_reason FROM padafand_players ORDER BY last_seen DESC LIMIT 500");res.json(r.rows);}catch(e){res.status(500).end();}});
app.patch("/api/admin/players/:id",requireAdmin,async(req,res)=>{
 const id=String(req.params.id),b=req.body||{};
 try{const r=await pool.query(`UPDATE padafand_players SET coins=COALESCE($2,coins),homing_ammo=COALESCE($3,homing_ammo),blocked=COALESCE($4,blocked),block_reason=COALESCE($5,block_reason),best_score=COALESCE($6,best_score),last_score=COALESCE($7,last_score) WHERE player_id=$1 RETURNING player_id,username,coins,homing_ammo,blocked,block_reason,best_score,last_score`,[id,b.coins===undefined?null:Math.max(0,Math.min(10000000,Math.floor(Number(b.coins)||0))),b.homingAmmo===undefined?null:Math.max(0,Math.min(100000,Math.floor(Number(b.homingAmmo)||0))),b.blocked===undefined?null:!!b.blocked,b.blockReason===undefined?null:String(b.blockReason).slice(0,300),b.bestScore===undefined?null:Math.max(0,Math.floor(Number(b.bestScore)||0)),b.lastScore===undefined?null:Math.max(0,Math.floor(Number(b.lastScore)||0))]);if(!r.rowCount)return res.status(404).json({error:"بازیکن پیدا نشد"});res.json({ok:true,player:r.rows[0]});}catch(e){res.status(500).json({error:"player update"});}
});
app.put("/api/admin/settings",requireAdmin,async(req,res)=>{const body=req.body||{};const data={missilePrice:Math.max(1,Math.min(100000,Number(body.missilePrice)||10)),gameTitle:String(body.gameTitle||defaults.gameTitle).slice(0,80),announcement:String(body.announcement||"").slice(0,500),rewardPerHit:Math.max(0,Math.min(20,Number(body.rewardPerHit)||0)),maxErrors:Math.max(1,Math.min(10,Math.floor(Number(body.maxErrors)||3))),startingCoins:Math.max(0,Math.min(100000,Math.floor(Number(body.startingCoins)||0))),shopEnabled:body.shopEnabled!==false,gameEnabled:body.gameEnabled!==false};
try{await pool.query("UPDATE padafand_game_settings SET data=$1,updated_at=NOW() WHERE id=1",[JSON.stringify(data)]);res.json({ok:true,data});}catch(e){res.status(500).end();}});
app.post("/api/admin/events",requireAdmin,async(req,res)=>{const title=String(req.body?.title||"").slice(0,100),description=String(req.body?.description||"").slice(0,500);if(!title)return res.status(400).json({error:"عنوان لازم است"});try{const r=await pool.query("INSERT INTO padafand_game_events(title,description,starts_at,ends_at,active) VALUES($1,$2,$3,$4,true) RETURNING *",[title,description,req.body?.startsAt||null,req.body?.endsAt||null]);res.json(r.rows[0]);}catch(e){res.status(500).end();}});
app.patch("/api/admin/events/:id",requireAdmin,async(req,res)=>{try{const r=await pool.query("UPDATE padafand_game_events SET active=$1 WHERE id=$2 RETURNING *",[!!req.body?.active,Number(req.params.id)]);res.json(r.rows[0]||{});}catch(e){res.status(500).end();}});
app.get("/admin-sw.js",(req,res)=>{res.setHeader("Service-Worker-Allowed","/admin");res.sendFile(path.join(__dirname,"admin-sw.js"));});
app.use(express.static(path.join(__dirname)));
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"admin.html")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
init().then(()=>app.listen(PORT,"0.0.0.0",()=>console.log("Padafand server on "+PORT))).catch(e=>{console.error(e);process.exit(1);});
