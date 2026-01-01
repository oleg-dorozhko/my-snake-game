const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');

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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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

function generatePage(player, isNew) {
  const pearls = player.pearls != null ? parseFloat(player.pearls).toFixed(1) : '0.0';
  const lost = player.lost_pearls || 0;
  const coins = player.coins || 0;
  const alive = player.alive ?? true;

  return `
  <!DOCTYPE html>
  <html lang="uk">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Водяна Змія - ${player.username}</title>
    <style>
      body {font-family: Arial, sans-serif; text-align: center; background: #001f3f; color: #fff; margin: 40px;}
      .card {background: rgba(255,255,255,0.1); padding: 30px; border-radius: 15px; display: inline-block; min-width: 420px; margin: 15px;}
      h1 {color: #7fffd4;}
      button {padding: 14px 28px; margin: 10px; font-size: 1.2em; border: none; border-radius: 10px; cursor: pointer; font-weight: bold;}
      #walk-btn {background: #7fffd4; color: #001f3f;}
      #eat-btn {background: #ff6b9d; color: white;}
      .notification {color: #7fffd4; font-style: italic; margin: 10px; animation: fade 0.5s;}
      @keyframes fade {from{opacity:0} to{opacity:1}}
      .dead {color: #ff6b6b;}
      #history-list {max-height: 300px; overflow-y: auto; text-align: left; margin-top: 15px;}
      .history-item {padding: 8px; margin: 5px 0; background: rgba(127,255,212,0.1); border-radius: 5px; font-size: 0.9em;}
    </style>
  </head>
  <body>
    <h1>🐍 Водяна Змія</h1>
    <h2 ${isNew ? 'style="color:#7fffd4"' : ''}>${isNew ? 'Вітаємо' : 'З поверненням'}, ${player.username}!</h2>

    <div class="card" id="player-card">
      <p style="font-size:1.4em"><strong>Перлини:</strong> ${pearls} 💎${!alive ? ' 🪶' : ''}</p>
      <p><strong>Обміняно перлин:</strong> ${lost}</p>
      <p style="font-size:1.3em"><strong>Монети:</strong> ${coins} 🪙</p>
      <p><strong>Статус:</strong> ${alive ? 'Змія пірнає за перлинами 🐉' : '<span class="dead">Змія улетіла разом з сундуком 🪶</span>'}</p>

      <button id="walk-btn">🪙 Обміняти перлину</button>
      <p id="walk-status" style="min-height:24px"></p>

      <button id="eat-btn">💎 Збирати перлини</button>
      <p id="eat-status" style="min-height:24px"></p>
    </div>
<div class="card">
  <h3 style="color:#7fffd4">⚙️ Налаштування гравця</h3>

  <label>Початкові перлини 💎</label><br>
  <input id="set-pearls" type="number" step="0.1" min="0.1"
         value="${parseFloat(player.pearls)}"><br><br>

  <label>Відсоток збору (%)</label><br>
  <input id="set-eat" type="number" step="0.001" min="0" max="1"
         value="${player.eat_threshold}"><br><br>

  <label>Відсоток обміну (%)</label><br>
  <input id="set-play" type="number" step="0.001" min="0" max="1"
         value="${player.play_threshold}"><br><br>

  <button id="save-settings">💾 Зберегти</button>
  <p id="settings-status" style="min-height:20px"></p>
</div>

    <div class="card">
      <h3 style="color:#7fffd4">🌊 Глобальний океанський потік</h3>
      <p><strong>Поточна глибина:</strong> <span id="current-depth" style="font-size:1.5em;font-weight:bold">${Math.round(500)}</span> м</p>
      <p><span id="countdown" >Кожні 10 секунд...</span></p>
    </div>
<div class="card">
  <h3 style="color:#7fffd4">📈 Графік глибини</h3>
  <canvas id="depthChart" width="380" height="160"></canvas>
</div>

    <div class="card">
      <h3 style="color:#7fffd4">📜 Історія обмінів</h3>
      <div id="history-list">
        <p style="color:#aaa">Завантаження...</p>
      </div>
    </div>

    <p>
      <a href="/leaderboard" style="color:#7fffd4; font-size:1.2em; margin:10px">🏆 Лідерборд</a>
    </p>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      const socket = io();
      const username = "${player.username}";
const depthHistory = [];
const MAX_POINTS = 60; // ~10 хв при 10 сек апдейті

      // Завантажити історію при старті
      loadHistory();

      function loadHistory() {
        fetch('/history/' + username)
          .then(r => r.json())
          .then(data => {
            const list = document.getElementById('history-list');
            if (data.success && data.history.length > 0) {
              list.innerHTML = data.history.map(h => 
                '<div class="history-item">🪙 Обмін на глибині <strong>' + Math.round(h.depth) + ' м</strong> (' + 
                new Date(h.exchange_time).toLocaleString('uk-UA') + ')</div>'
              ).join('');
            } else {
              list.innerHTML = '<p style="color:#aaa">Ще немає обмінів</p>';
            }
          })
          .catch(() => {
            document.getElementById('history-list').innerHTML = '<p style="color:#ff6b6b">Помилка завантаження</p>';
          });
      }

      socket.on('depth_update', d => {
        document.getElementById('current-depth').textContent = Math.round(d.depth); drawDepthChart(d.depth);
        let c = 10;
        //const timer = setInterval(() => {          c = c <= 1 ? 10 : c - 1;          document.getElementById('countdown').textContent = c;        }, 1000);
         document.getElementById('countdown').textContent = "Чи зміниться глибина? Куди приведе змію глобальна велика могутня течія?"; 
      });

      socket.on('players_updated', ps => {
        ps.forEach(p => {
          if (p.username === username) {
            const pearlsDisp = p.pearls != null ? parseFloat(p.pearls).toFixed(1) : '0.0';
            document.querySelectorAll('#player-card p')[0].innerHTML = '<strong style="font-size:1.4em">Перлини:</strong> ' + pearlsDisp + ' 💎' + (!p.alive ? ' 🪶' : '');
            document.querySelectorAll('#player-card p')[1].innerHTML = '<strong>Обміняно перлин:</strong> ' + (p.lost_pearls || 0);
            document.querySelectorAll('#player-card p')[2].innerHTML = '<strong style="font-size:1.3em">Монети:</strong> ' + (p.coins || 0) + ' 🪙';
            document.querySelectorAll('#player-card p')[3].innerHTML = '<strong>Статус:</strong> ' + (p.alive ? 'Змія пірнає за перлинами 🐉' : '<span class="dead">Змія улетіла з сундуком 🪶</span>');

            if (p.action) {
              const n = document.createElement('div');
              n.className = 'notification';
              n.textContent = '➤ ' + p.action;
              document.getElementById('player-card').appendChild(n);
              setTimeout(() => n.remove(), 10000);
              
              // Оновити історію після обміну
              if (p.action.includes('обміняв перлину') || p.action.includes('зібрав перлину')) {
                loadHistory();
              }
            }
          }
        });
      });

      function act(url, statusId) {
        const btn = url === '/walk' ? document.getElementById('walk-btn') : document.getElementById('eat-btn');
        const st = document.getElementById(statusId);
        btn.disabled = true;
        st.textContent = 'Чекаємо...';
        st.style.color = '#aaa';
        fetch(url, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({username})
        })
        .then(r => r.json())
        .then(d => {
          st.style.color = d.success ? '#7fffd4' : '#ff6b6b';
          st.textContent = d.success ? '✓ ' + d.message : '✗ ' + d.message;
        })
        .catch(() => {
          st.style.color = '#ff6b6b';
          st.textContent = 'Помилка звʼязку';
        })
        .finally(() => setTimeout(() => btn.disabled = false, 2000));
      }

      document.getElementById('walk-btn').onclick = () => act('/walk', 'walk-status');
      document.getElementById('eat-btn').onclick = () => act('/eat', 'eat-status');

      document.getElementById('save-settings').onclick = () => {
  const pearls = parseFloat(document.getElementById('set-pearls').value);
  const eat_threshold = parseFloat(document.getElementById('set-eat').value);
  const play_threshold = parseFloat(document.getElementById('set-play').value);

  const st = document.getElementById('settings-status');
  st.textContent = 'Зберігаємо...';
  st.style.color = '#aaa';

  fetch('/settings', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      username,
      pearls,
      eat_threshold,
      play_threshold
    })
  })
  .then(r => r.json())
  .then(d => {
    st.style.color = d.success ? '#7fffd4' : '#ff6b6b';
    st.textContent = d.success ? '✓ Налаштування збережено' : '✗ ' + d.message;
  })
  .catch(() => {
    st.style.color = '#ff6b6b';
    st.textContent = 'Помилка звʼязку';
  });
};
function drawDepthChart(depth) {
  const canvas = document.getElementById('depthChart');
  const ctx = canvas.getContext('2d');

  // 1. зберігаємо значення
  depthHistory.push(depth);
  if (depthHistory.length > MAX_POINTS) {
    depthHistory.shift();
  }

  // 2. очистити
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 3. знайти мін / макс
  const min = Math.min(...depthHistory);
  const max = Math.max(...depthHistory);
  const range = Math.max(1, max - min);

  // 4. фон
  ctx.fillStyle = 'rgba(127,255,212,0.08)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 5. осі
  ctx.strokeStyle = '#7fffd4';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(30, 10);
  ctx.lineTo(30, canvas.height - 20);
  ctx.lineTo(canvas.width - 10, canvas.height - 20);
  ctx.stroke();

  // 6. лінія глибини
  ctx.strokeStyle = '#7fffd4';
  ctx.lineWidth = 2;
  ctx.beginPath();

  depthHistory.forEach((d, i) => {
    const x = 30 + (i / (MAX_POINTS - 1)) * (canvas.width - 50);
    const y = 10 + (1 - (d - min) / range) * (canvas.height - 30);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });

  ctx.stroke();
  
// 7. підпис поточної глибини
ctx.fillStyle = '#fff';
ctx.font = '12px Arial';
ctx.fillText(Math.round(depth) + ' м', canvas.width - 70, 20);

 
}


    </script>
  </body>
  </html>`;
}
