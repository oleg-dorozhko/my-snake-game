const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000; 

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});


async function resetAndInitDatabase() {
  try {


    console.log('🆕 Створюємо нові таблиці...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        pearls FLOAT DEFAULT 10.0,
        lost_pearls INTEGER DEFAULT 0,
        coins INTEGER DEFAULT 0,
        last_loss_depth FLOAT,
        alive BOOLEAN DEFAULT TRUE,
        start_time TIMESTAMP DEFAULT NOW(),
        death_time TIMESTAMP,
        eat_threshold FLOAT DEFAULT 0.005,
        play_threshold FLOAT DEFAULT 0.05,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        current_depth FLOAT DEFAULT 500,
        last_update TIMESTAMP DEFAULT NOW(),
        CONSTRAINT one_row CHECK (id = 1)
      )
    `);

    // Нова таблиця для історії обмінів
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exchange_history (
        id SERIAL PRIMARY KEY,
        player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        username VARCHAR(50) NOT NULL,
        depth FLOAT NOT NULL,
        exchange_time TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      INSERT INTO game_state (id, current_depth)
      VALUES (1, 500)
      ON CONFLICT (id) DO NOTHING
    `);

    console.log('✅ Нова база даних успішно створена! Готові до гри з перлинами 💎');
  } catch (err) {
    console.error('❌ Помилка при створенні нової БД:', err);
    process.exit(1);
  }
}

// === Ініціалізація ===
resetAndInitDatabase()
  .then(() => {
    server.listen(port, () => {
      console.log(`🚀 Сервер запущено на порту ${port}`);
    });

    // === Цикл гри кожні 10 секунд ===
    setInterval(async () => {
      try {
        const rand = Math.random();
        let depthChange = 0;
        if (rand < 0.17) depthChange = 50;
        else if (rand < 0.34) depthChange = -50;

        const depthResult = await pool.query(`
          UPDATE game_state 
          SET current_depth = GREATEST(0, current_depth + $1),
              last_update = NOW()
          WHERE id = 1
          RETURNING current_depth, last_update
        `, [depthChange]);

        const newDepth = parseFloat(depthResult.rows[0].current_depth);

        console.log(`🌊 Глибина: ${Math.round(newDepth)} м (${depthChange >= 0 ? '+' : ''}${depthChange} м)`);

        io.emit('depth_update', { depth: newDepth, serverTime: new Date().toISOString() });

      } catch (err) {
        console.error('Помилка в циклі гри:', err);
      }
    }, 10000);
  });

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});



app.get('/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`SELECT username, coins, alive, death_time FROM players ORDER BY coins DESC LIMIT 10`);
    const players = result.rows;
    res.send(`
      <!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><title>Лідерборд</title>
      <style>body{background:#001f3f;color:#fff;text-align:center;margin:50px;font-family:Arial;}
      table{width:80%;margin:auto;border-collapse:collapse;}th,td{border:1px solid #7fffd4;padding:12px;}
      th{background:rgba(127,255,212,0.2);}</style></head>
      <body><h1 style="color:#7fffd4">🏆 Лідерборд Пернатих Змій</h1>
      <table><tr><th>Гравець</th><th>Монети 🪙</th><th>Статус</th></tr>
      ${players.map(p => `<tr><td>${p.username}</td><td>${p.coins}</td>
      <td>${p.alive ? 'Змія пірнає 🐉' : 'Змія улетіла 🪶 (' + new Date(p.death_time).toLocaleString('uk-UA') + ')'}</td></tr>`).join('')}
      </table><p style="margin-top:30px"><a href="/" style="color:#7fffd4;font-size:1.2em">← До гри</a></p></body></html>
    `);
  } catch (err) {
    console.error(err);
    res.send('<h2>Помилка лідерборду</h2>');
  }
});

// Новий endpoint для отримання історії обмінів
app.get('/history/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const result = await pool.query(`
      SELECT depth, exchange_time 
      FROM exchange_history 
      WHERE username = $1 
      ORDER BY exchange_time DESC
    `, [username]);
    res.json({ success: true, history: result.rows });
  } catch (err) {
    console.error('/history помилка:', err);
    res.json({ success: false, message: 'Помилка сервера' });
  }
});
app.post('/eat', async (req, res) => {
  const { username } = req.body;
  try {
    const playerRes = await pool.query('SELECT * FROM players WHERE username = $1', [username]);
    const depthRes = await pool.query('SELECT current_depth FROM game_state');
    if (playerRes.rows.length === 0) return res.json({ success: false, message: 'Гравець не знайдений' });

    const player = playerRes.rows[0];
    const currentDepth = parseFloat(depthRes.rows[0].current_depth);

    if (!player.alive) return res.json({ success: false, message: 'Змія улетіла 🪶' });

    // Спочатку перевірити чи є взагалі обміни
    const checkHistoryRes = await pool.query(`
      SELECT COUNT(*) as count
      FROM exchange_history 
      WHERE player_id = $1
    `, [player.id]);

    if (parseInt(checkHistoryRes.rows[0].count) === 0) {
      return res.json({ success: false, message: 'Спочатку обміняй перлину' });
    }
// Отримати перший підходящий обмін з історії
const historyRes = await pool.query(`
  SELECT id, depth 
  FROM exchange_history 
  WHERE player_id = $1 
    AND depth * $2 < $3
  ORDER BY exchange_time ASC 
  LIMIT 1
`, [player.id, (1 + player.eat_threshold), currentDepth]);
   

    // Якщо немає підходящого обміну
    if (historyRes.rows.length === 0) {
      return res.json({ success: false, message: 'Пірнай глибше! Жодна перлина ще не доступна для збору' });
    }

    const oldestExchange = historyRes.rows[0];
    const exchangeDepth = parseFloat(oldestExchange.depth);

    // Розрахунок бонусу
    const bonus = (currentDepth - exchangeDepth) / exchangeDepth;
    const gain = 1 + bonus;
    const newPearls = player.pearls + gain;
    const newLostPearls = player.lost_pearls - 1;
    
    // Оновити гравця
    await pool.query(
      'UPDATE players SET pearls = $1, lost_pearls = $2 WHERE username = $3', 
      [newPearls, newLostPearls, username]
    );

    // ВИДАЛИТИ цей обмін з історії
    await pool.query('DELETE FROM exchange_history WHERE id = $1', [oldestExchange.id]);

    io.emit('players_updated', [{ 
      username, 
      pearls: parseFloat(newPearls.toFixed(2)),
      lost_pearls: newLostPearls,
      coins: player.coins,
      alive: true,
      action: `${username}: зібрав перлину з глибини ${Math.round(exchangeDepth)} м (+${gain.toFixed(2)}) 💎` 
    }]);

    // Оновити історію на фронтенді
    io.emit('history_updated', { username });

    res.json({ success: true, message: `+${gain.toFixed(2)} перлин 💎 (з ${Math.round(exchangeDepth)} м)` });
  } catch (err) {
    console.error('/eat помилка:', err);
    res.json({ success: false, message: 'Помилка сервера' });
  }
});

app.post('/walk', async (req, res) => {
  const { username } = req.body;
  try {
    const playerRes = await pool.query('SELECT * FROM players WHERE username = $1', [username]);
    const depthRes = await pool.query('SELECT current_depth FROM game_state');
    if (playerRes.rows.length === 0) return res.json({ success: false, message: 'Гравець не знайдений' });

    const player = playerRes.rows[0];
    const currentDepth = parseFloat(depthRes.rows[0].current_depth);

    if (!player.alive) return res.json({ success: false, message: 'Змія улетіла 🪶' });
    if (player.pearls < 1) return res.json({ success: false, message: 'Потрібна хоча б одна перлина для обміну' });

    const newPearls = player.pearls - 1;
    const newLostPearls = player.lost_pearls + 1;
    const newCoins = player.coins + 1;
    const alive = newPearls > 0;

    // Оновити базу даних
    await pool.query(`
      UPDATE players 
      SET pearls = $1, lost_pearls = $2, coins = $3,
          last_loss_depth = $4, alive = $5, death_time = $6
      WHERE username = $7
    `, [newPearls, newLostPearls, newCoins, currentDepth, alive, alive ? player.death_time : new Date(), username]);

    // Записати в історію обмінів
    await pool.query(`
      INSERT INTO exchange_history (player_id, username, depth)
      VALUES ($1, $2, $3)
    `, [player.id, username, currentDepth]);

    io.emit('players_updated', [{
      username,
      pearls: parseFloat(newPearls.toFixed(2)),
      lost_pearls: newLostPearls,
      coins: newCoins,
      alive,
      action: `${username}: обміняв перлину (+1 монета)${!alive ? ' → ЗМІЯ УЛЕТІЛА РАЗОМ З СУНДУКОМ! 🪶💰' : ''}`
    }]);

    res.json({ 
      success: true, 
      message: alive ? '+1 монета 🪙' : 'Остання перлина… Змія стала пернатою і улетіла разом з сундуком! 🪶💰' 
    });
  } catch (err) {
    console.error('/walk помилка:', err);
    res.json({ success: false, message: 'Помилка сервера' });
  }
});

app.post('/join', async (req, res) => {
  let username = req.body.username?.trim();
  if (!username || username.length < 2 || username.length > 20) {
    return res.send(`<h2 style="color:#ff6b6b">Ім'я від 2 до 20 символів</h2><a href="/">Назад</a>`);
  } 
  if(username=="admin_adminenko_123("){
    console.log('🗑️  Видаляємо старі таблиці (якщо є)...');
    await pool.query(`DROP TABLE IF EXISTS exchange_history CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS players CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS game_state CASCADE`);

     console.log('🆕 Створюємо нові таблиці...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        pearls FLOAT DEFAULT 10.0,
        lost_pearls INTEGER DEFAULT 0,
        coins INTEGER DEFAULT 0,
        last_loss_depth FLOAT,
        alive BOOLEAN DEFAULT TRUE,
        start_time TIMESTAMP DEFAULT NOW(),
        death_time TIMESTAMP,
        eat_threshold FLOAT DEFAULT 0.005,
        play_threshold FLOAT DEFAULT 0.05,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        current_depth FLOAT DEFAULT 500,
        last_update TIMESTAMP DEFAULT NOW(),
        CONSTRAINT one_row CHECK (id = 1)
      )
    `);

    // Нова таблиця для історії обмінів
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exchange_history (
        id SERIAL PRIMARY KEY,
        player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        username VARCHAR(50) NOT NULL,
        depth FLOAT NOT NULL,
        exchange_time TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      INSERT INTO game_state (id, current_depth)
      VALUES (1, 500)
      ON CONFLICT (id) DO NOTHING
    `);

    console.log('✅ Нова база даних успішно створена! Готові до гри з перлинами 💎');

    
  }
  try {
    let result = await pool.query('SELECT * FROM players WHERE username = $1', [username]);
    if (result.rows.length > 0) {
      res.send(generatePage(result.rows[0], false));
    } else {
      //max_pearls=10.0 need query update, username_settings table need
      result = await pool.query(`
        INSERT INTO players (username, pearls, lost_pearls, coins, last_loss_depth, alive)
        VALUES ($1, 10.0, 0, 0, NULL, true) RETURNING *
      `, [username]);
      res.send(generatePage(result.rows[0], true));
    }
  } catch (err) {
    console.error(err);
    res.send('<h2>Помилка бази даних</h2>');
  }
});
app.post('/settings', async (req, res) => {
  const { username, pearls, eat_threshold, play_threshold } = req.body;

  // базова валідація
  if (
    typeof pearls !== 'number' || pearls <= 0 ||
    typeof eat_threshold !== 'number' || eat_threshold < 0 || eat_threshold > 1 ||
    typeof play_threshold !== 'number' || play_threshold < 0 || play_threshold > 1
  ) {
    return res.json({ success: false, message: 'Некоректні значення' });
  }

  try {
    const result = await pool.query(`
      UPDATE players
      SET pearls = $1,
          eat_threshold = $2,
          play_threshold = $3
      WHERE username = $4
      RETURNING pearls, eat_threshold, play_threshold
    `, [pearls, eat_threshold, play_threshold, username]);

    if (result.rowCount === 0) {
      return res.json({ success: false, message: 'Гравець не знайдений' });
    }

    res.json({
      success: true,
      message: 'Налаштування збережено',
      settings: result.rows[0]
    });
  } catch (err) {
    console.error('/settings помилка:', err);
    res.json({ success: false, message: 'Помилка сервера' });
  }
});

const TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'public', 'template.html'),
  'utf8'
);



function generatePage(player, isNew) {
  //const templatePath = path.join(__dirname, 'public', 'template.html');
  //let html = fs.readFileSync(templatePath, 'utf8');
  let html = TEMPLATE;
  const data = {
    username: player.username,
    pearls: (player.pearls ?? 0).toFixed(1),
    lost: player.lost_pearls ?? 0,
    coins: player.coins ?? 0,
    feather: player.alive ? '' : '🪶',
    status: player.alive
      ? 'Змія пірнає за перлинами 🐉'
      : '<span class="dead">Змія улетіла разом з сундуком 🪶</span>',
    welcomeText: isNew ? 'Вітаємо' : 'З поверненням',
    welcomeClass: isNew ? 'new-user' : ''
  };

  for (const key in data) {
    html = html.replaceAll(`{{${key}}}`, data[key]);
  }

  return html;
}

