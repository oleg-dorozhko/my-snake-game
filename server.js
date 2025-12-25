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
    //console.log('🗑️  Видаляємо старі таблиці (якщо є)...');
    //await pool.query(`DROP TABLE IF EXISTS players CASCADE`);
    //await pool.query(`DROP TABLE IF EXISTS game_state CASCADE`);

    console.log('🆕 Створюємо нові таблиці...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        pearls FLOAT DEFAULT 50.0,
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
      CREATE TABLE  IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        current_depth FLOAT DEFAULT 500,
        last_update TIMESTAMP DEFAULT NOW(),
        CONSTRAINT one_row CHECK (id = 1)
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

        const playersResult = await pool.query(`SELECT * FROM players WHERE alive = TRUE`);
        let updatedPlayers = [];

        for (let row of playersResult.rows) {
          let updated = false;
          let actionLog = `${row.username}: `;

          let pearls = parseFloat(row.pearls || 0);
          let lostPearls = parseInt(row.lost_pearls || 0);
          let coins = parseInt(row.coins || 0);
          let lastLossDepth = row.last_loss_depth ? parseFloat(row.last_loss_depth) : null;

          // Збирати перлини (глибше)
          if (pearls < 50 && lastLossDepth !== null && newDepth > lastLossDepth * (1 + row.eat_threshold)) {
            const bonus = (newDepth - lastLossDepth) / lastLossDepth;
            const gain = 1 + bonus * 2;
            pearls = Math.min(50, pearls + gain);
            updated = true;
            actionLog += `зібрав перлини (+${gain.toFixed(2)}) 💎 `;
          }

          // Обміняти (мілкіше або перший раз)
          if (pearls >= 50 && (lastLossDepth === null || newDepth <= lastLossDepth * (1 - row.play_threshold))) {
            pearls -= 1;
            lostPearls += 1;
            coins += 1;
            lastLossDepth = newDepth;
            updated = true;
            actionLog += `обміняв перлину (+1 монета) 🪙 `;

            if (pearls <= 0) {
              pearls = 0;
              row.alive = false;
              actionLog += `→ ЗМІЯ СТАЛА ПЕРНАТОЮ І ВІДЛЕТІЛА З СУНДУКОМ! 🪶💰`;
            }
          }

          if (updated) {
            await pool.query(`
              UPDATE players 
              SET pearls = $1, lost_pearls = $2, coins = $3, last_loss_depth = $4,
                  alive = $5, death_time = $6
              WHERE id = $7
            `, [
              pearls, lostPearls, coins, lastLossDepth,
              pearls > 0, pearls <= 0 ? new Date() : row.death_time,
              row.id
            ]);

            updatedPlayers.push({
              username: row.username,
              pearls: parseFloat(pearls.toFixed(2)),
              lost_pearls: lostPearls,
              coins: coins,
              alive: pearls > 0,
              action: actionLog.trim()
            });

            console.log(`🐍 ${actionLog.trim()}`);
          }
        }

        io.emit('depth_update', { depth: newDepth, serverTime: new Date().toISOString() });
        if (updatedPlayers.length > 0) io.emit('players_updated', updatedPlayers);

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
      <td>${p.alive ? 'Пірнає 🐉' : 'Відлетіла 🪶 (' + new Date(p.death_time).toLocaleString('uk-UA') + ')'}</td></tr>`).join('')}
      </table><p style="margin-top:30px"><a href="/" style="color:#7fffd4;font-size:1.2em">← До гри</a></p></body></html>
    `);
  } catch (err) {
    console.error(err);
    res.send('<h2>Помилка лідерборду</h2>');
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

    if (!player.alive) return res.json({ success: false, message: 'Змія відлетіла 🪶' });
    if (player.pearls >= 50) return res.json({ success: false, message: 'Перлин повно (50/50)' });
    if (player.last_loss_depth === null) return res.json({ success: false, message: 'Спочатку обміняй перлину' });

    const threshold = player.last_loss_depth * (1 + player.eat_threshold);
    if (currentDepth <= threshold) {
      return res.json({ success: false, message: `Пірнай глибше! (зараз ${Math.round(currentDepth)} м, треба > ${Math.round(threshold)} м)` });
    }

    const bonus = (currentDepth - player.last_loss_depth) / player.last_loss_depth;
    const gain = 1 + bonus;
    const newPearls = Math.min(50, player.pearls + gain);

    await pool.query('UPDATE players SET pearls = $1 WHERE username = $2', [newPearls, username]);

    io.emit('players_updated', [{ username, pearls: parseFloat(newPearls.toFixed(2)), action: `${username}: зібрав перлини вручну (+${gain.toFixed(2)}) 💎` }]);

    res.json({ success: true, message: `+${gain.toFixed(2)} перлин 💎` });
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

    if (!player.alive) return res.json({ success: false, message: 'Змія відлетіла 🪶' });
    //if (player.pearls < 50) return res.json({ success: false, message: 'Потрібно 50 перлин для обміну' });

    const threshold = player.last_loss_depth ? player.last_loss_depth * (1 - player.play_threshold) : currentDepth;
    if (currentDepth > threshold) {
      return res.json({ success: false, message: `Піднімись вище! (зараз ${Math.round(currentDepth)} м, треба ≤ ${Math.round(threshold)} м)` });
    }

    const newPearls = player.pearls - 1;
    const alive = newPearls > 0;

    await pool.query(`
      UPDATE players 
      SET pearls = $1, lost_pearls = lost_pearls + 1, coins = coins + 1,
          last_loss_depth = $2, alive = $3, death_time = $4
      WHERE username = $5
    `, [newPearls, currentDepth, alive, alive ? player.death_time : new Date(), username]);

    io.emit('players_updated', [{
      username,
      pearls: parseFloat(newPearls.toFixed(2)),
      coins: player.coins + 1,
      alive,
      action: `${username}: обміняв перлину (+1 монета)${!alive ? ' → ВІДЛЕТІЛА РАЗОМ З СУНДУКОМ! 🪶💰' : ''}`
    }]);

    res.json({ success: true, message: alive ? '+1 монета 🪙' : 'Остання перлина… Змія стала пернатою і відлетіла разом з сундуком! 🪶💰' });
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

  try {
    let result = await pool.query('SELECT * FROM players WHERE username = $1', [username]);
    if (result.rows.length > 0) {
      res.send(generatePage(result.rows[0], false));
    } else {
      result = await pool.query(`
        INSERT INTO players (username, pearls, lost_pearls, coins, last_loss_depth, alive)
        VALUES ($1, 50.0, 0, 0, NULL, true) RETURNING *
      `, [username]);
      res.send(generatePage(result.rows[0], true));
    }
  } catch (err) {
    console.error(err);
    res.send('<h2>Помилка бази даних</h2>');
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
    </style>
  </head>
  <body>
    <h1>🐍 Водяна Змія</h1>
    <h2 ${isNew ? 'style="color:#7fffd4"' : ''}>${isNew ? 'Вітаємо' : 'З поверненням'}, ${player.username}!</h2>

    <div class="card" id="player-card">
      <p style="font-size:1.4em"><strong>Перлини:</strong> ${pearls} 💎${!alive ? ' 🪶' : ''}</p>
      <p><strong>Обміняно перлин:</strong> ${lost}</p>
      <p style="font-size:1.3em"><strong>Монети:</strong> ${coins} 🪙</p>
      <p><strong>Статус:</strong> ${alive ? 'Пірнає за перлинами 🐉' : '<span class="dead">Відлетіла разом з сундуком 🪶</span>'}</p>

      <button id="walk-btn">🪙 Обміняти перлину</button>
      <p id="walk-status" style="min-height:24px"></p>

      <button id="eat-btn">💎 Збирати перлини</button>
      <p id="eat-status" style="min-height:24px"></p>
    </div>

    <div class="card">
      <h3 style="color:#7fffd4">🌊 Глобальний океанський потік</h3>
      <p><strong>Поточна глибина:</strong> <span id="current-depth" style="font-size:1.5em;font-weight:bold">${Math.round(500)}</span> м</p>
      <p>Наступна зміна через <span id="countdown" style="font-weight:bold">30</span> секунд</p>
    </div>

    <p>
      <a href="/leaderboard" style="color:#7fffd4; font-size:1.2em; margin:10px">🏆 Лідерборд</a> |
      <a href="/" style="color:#7fffd4; font-size:1.2em; margin:10px">Змінити ім'я</a>
    </p>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      const socket = io();
      const username = "${player.username}";

      socket.on('depth_update', d => {
        document.getElementById('current-depth').textContent = Math.round(d.depth);
        let c = 30;
        const timer = setInterval(() => {
          c = c <= 1 ? 30 : c - 1;
          document.getElementById('countdown').textContent = c;
        }, 1000);
      });

      socket.on('players_updated', ps => {
        ps.forEach(p => {
          if (p.username === username) {
            const pearlsDisp = p.pearls != null ? parseFloat(p.pearls).toFixed(1) : '0.0';
            document.querySelectorAll('#player-card p')[0].innerHTML = '<strong style="font-size:1.4em">Перлини:</strong> ' + pearlsDisp + ' 💎' + (!p.alive ? ' 🪶' : '');
            document.querySelectorAll('#player-card p')[1].innerHTML = '<strong>Обміняно перлин:</strong> ' + (p.lost_pearls || 0);
            document.querySelectorAll('#player-card p')[2].innerHTML = '<strong style="font-size:1.3em">Монети:</strong> ' + (p.coins || 0) + ' 🪙';
            document.querySelectorAll('#player-card p')[3].innerHTML = '<strong>Статус:</strong> ' + (p.alive ? 'Пірнає за перлинами 🐉' : '<span class="dead">Відлетіла з сундуком 🪶</span>');

            if (p.action) {
              const n = document.createElement('div');
              n.className = 'notification';
              n.textContent = '➤ ' + p.action;
              document.getElementById('player-card').appendChild(n);
              setTimeout(() => n.remove(), 10000);
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
    </script>
  </body>
  </html>`;
}
