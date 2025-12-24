const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');

const app = express();
const port = process.env.PORT || 3000;

// Підключення до PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Створюємо HTTP сервер і підключаємо Socket.io
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: {
    origin: "*", // пізніше можна обмежити
    methods: ["GET", "POST"]
  }
});

// === Перевірка підключення до БД ===
async function checkDatabaseConnection() {
  try {
    const client = await pool.connect();
    client.release();
    console.log('🐘 Конекшн з БД успішний');
  } catch (err) {
    console.error('❌ Помилка підключення до БД:', err.message);
    process.exit(1);
  }
}

// === Ініціалізація БД і запуск сервера ===
checkDatabaseConnection()
  .then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      scales FLOAT DEFAULT 50,
      lost_scales INTEGER DEFAULT 0,
      coins INTEGER DEFAULT 0,
      last_loss_depth FLOAT,
      alive BOOLEAN DEFAULT TRUE,
      start_time TIMESTAMP DEFAULT NOW(),
      death_time TIMESTAMP,
      eat_threshold FLOAT DEFAULT 0.005,
      play_threshold FLOAT DEFAULT 0.05,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `))
  .then(() => {
    console.log('📊 Таблиця players готова або вже існує');
    return pool.query(`
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        current_depth FLOAT DEFAULT 500,
        last_update TIMESTAMP DEFAULT NOW(),
        CONSTRAINT one_row CHECK (id = 1)
      )
    `);
  })
  .then(() => {
    console.log('🌊 Таблиця game_state готова або вже існує');
    return pool.query(`
      INSERT INTO game_state (id, current_depth)
      VALUES (1, 500)
      ON CONFLICT (id) DO NOTHING
    `);
  })
  .then(() => {
    console.log('🌊 Глобальна глибина ініціалізована (500 м)');

    // === ЗАПУСК СЕРВЕРА ЧЕРЕЗ server (для Socket.io) ===
    server.listen(port, () => {
      console.log(`🚀 Сервер запущено на порту ${port}`);
      console.log(`Відкрий: https://твій-сервіс.onrender.com`);
    });
    // === Глобальний потік + логіка змії кожні 30 сек ===
    setInterval(async () => {
      try {
        // 1. Оновлюємо глибину
        const rand = Math.random();
        let depthChange = 0;
        if (rand < 0.17) depthChange = 50;
        else if (rand < 0.34) depthChange = -50;

        const depthResult = await pool.query(`
          UPDATE game_state 
          SET current_depth = current_depth + $1,
              last_update = NOW()
          WHERE id = 1
          RETURNING current_depth, last_update
        `, [depthChange]);

        const { current_depth, last_update } = depthResult.rows[0];
        const newDepth = current_depth;

        console.log(`🌊 Глибина оновлена: ${Math.round(newDepth)} м (зміна: ${depthChange >= 0 ? '+' : ''}${depthChange} м)`);

        // 2. Отримуємо всіх живих гравців
        const playersResult = await pool.query(`
          SELECT * FROM players WHERE alive = TRUE
        `);
        let updatedPlayers = [];

        for (let player of playersResult.rows) {
          let updated = false;
          let actionLog = `${player.username}: `;
           // === Ініціалізація last_loss_depth якщо луска повна ===
  if (player.scales >= 50 && !player.last_loss_depth) {
    player.last_loss_depth = newDepth;
    updated = true;
    actionLog += `луска повна, готова до пригод на глибині ${Math.round(newDepth)}м `;
  }
  // === Резвитися (втрата луски при підйомі) ===
  else if (player.last_loss_depth && 
      newDepth <= player.last_loss_depth * (1 - player.play_threshold)) {
    
    player.scales -= 1;
    player.lost_scales += 1;
    player.coins += 1;
    player.last_loss_depth = newDepth;  // Оновлюємо позицію втрати
    updated = true;
    actionLog += `резвився (-1 луска, +1 монета) `;
    
    if (player.scales <= 0) {
      player.scales = 0;
      player.alive = false;
      player.death_time = new Date();
      actionLog += `→ ЗМІЯ ПОМЕРЛА 💀`;
    }
  }
  // === ПОТІМ Їсти (тільки якщо НЕ резвився цього тику) ===
  else if (player.scales < 50 &&
           player.last_loss_depth &&
           newDepth >= player.last_loss_depth * (1 + player.eat_threshold)) {
    
    const bonus = (newDepth - player.last_loss_depth) / player.last_loss_depth;
    player.scales += 1 + bonus;
    updated = true;
    actionLog += `їла (+1 + ${bonus.toFixed(3)} луски = +${(1 + bonus).toFixed(2)}) 🎣`;
  }


          if (updated) {
            await pool.query(`
              UPDATE players 
              SET scales = $1, 
                  lost_scales = $2, 
                  coins = $3, 
                  last_loss_depth = $4,
                  alive = $5,
                  death_time = $6
              WHERE id = $7
            `, [
              player.scales,
              player.lost_scales,
              player.coins,
              player.last_loss_depth,
              player.alive,
              player.death_time,
              player.id
            ]);

            updatedPlayers.push({
              id: player.id,
              username: player.username,
              scales: parseFloat(player.scales.toFixed(2)),
              lost_scales: player.lost_scales,
              coins: player.coins,
              alive: player.alive,
              action: actionLog.trim()
            });

            console.log(`🐍 ${actionLog.trim()}`);
          }
        }

        // 3. Розсилаємо оновлення всім клієнтам
        io.emit('depth_update', {
          depth: newDepth,
          lastUpdate: last_update.toISOString(),
          serverTime: new Date().toISOString()
        });

        if (updatedPlayers.length > 0) {
          io.emit('players_updated', updatedPlayers);
          console.log(`📢 Оновлено ${updatedPlayers.length} змій`);
        }

      } catch (err) {
        console.error('Помилка в циклі гри:', err);
      }
    }, 30000);
    

  })
  .catch(err => {
    console.error('Помилка ініціалізації бази даних:', err);
    process.exit(1);
  });

// Статичні файли та роути — залишаються тут (виконуються відразу, це нормально)
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Обробка введення імені
app.post('/join', async (req, res) => {
  const username = req.body.username.trim();
  const startDepth = 500;
  if (!username || username.length < 2 || username.length > 20) {
    return res.send(`
      <h2>Помилка: Ім'я має бути від 2 до 20 символів</h2>
      <a href="/">Спробувати ще раз</a>
    `);
  }

  try {
    // Шукаємо гравця
    let result = await pool.query('SELECT * FROM players WHERE username = $1', [username]);

    if (result.rows.length > 0) {
      // Гравець вже є
      const player = result.rows[0];
      res.send(generatePlayerPage(player, false));
    } else {
      // Створюємо нового
      const startDepth = 500;
      result = await pool.query(`
        INSERT INTO players 
        (username, scales, lost_scales, coins, last_loss_depth, alive, start_time)
        VALUES ($1, 50, 0, 0, $2, true, NOW())
        RETURNING *
      `, [username, startDepth]);  // <-- Додайте startDepth як $2
      

      const newPlayer = result.rows[0];
      res.send(generatePlayerPage(newPlayer, true));
    }
  } catch (err) {
    console.error(err);
    res.send('<h2>Помилка бази даних. Спробуйте пізніше.</h2>');
  }
});
function generatePlayerPage(player, isNew) {
  const welcomeMsg = isNew 
    ? `<h2 style="color:green;">Вітаємо, ${player.username}! Твоя водяна змія готова до пригод!</h2>`
    : `<h2>З поверненням, ${player.username}!</h2>`;

  // Важливо: весь клієнтський скрипт у лапках, як рядок!
  return `
    <!DOCTYPE html>
    <html lang="uk">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Водяна Змія</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; margin: 50px; background: #001f3f; color: #fff; }
        .card { background: rgba(255,255,255,0.1); padding: 30px; border-radius: 15px; display: inline-block; min-width: 400px; margin: 10px auto; }
        h1 { color: #7fffd4; }
        #current-depth { font-size: 1.5em; font-weight: bold; color: #7fffd4; }
        .notification { color: #7fffd4; font-style: italic; margin-top: 10px; }
      </style>
    </head>
    <body>
      <h1>🐍 Водяна Змія</h1>
      ${welcomeMsg}

      <div class="card" id="player-card">
        <p class="scales"><strong>Луска:</strong> ${player.scales.toFixed(1)}</p>
        <p class="lost"><strong>Втрачено луски:</strong> ${player.lost_scales}</p>
        <p class="coins"><strong>Монети:</strong> ${player.coins} 🪙</p>
        <p class="status"><strong>Статус:</strong> ${player.alive ? 'Жива 🐉' : 'Зникла 💀'}</p>
        <p><small>Гра запущена: ${new Date(player.start_time).toLocaleString('uk-UA')}</small></p>
      </div>

      <div class="card" style="background: rgba(0, 100, 200, 0.2);">
        <h3 style="color: #7fffd4;">🌊 Глобальний потік океану (реальний час)</h3>
        <p><strong>Поточна глибина:</strong> <span id="current-depth">500</span> м</p>
        <p><strong>Серверний час:</strong> <span id="server-time">--</span></p>
        <p><strong>Останнє оновлення:</strong> <span id="last-update">--</span></p>
        <p style="font-size: 0.9em; color: #aaa;">
          Наступна зміна — приблизно через <span id="countdown">30</span> секунд
        </p>
      </div>

      <script src="/socket.io/socket.io.js"></script>
      
<script>
  const socket = io();
  const username = "${player.username}";

  function formatDate(isoString) {
    if (!isoString) return '--';
    return new Date(isoString).toLocaleString('uk-UA', {
      timeZone: 'Europe/Kiev',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  socket.on('depth_update', (data) => {
    document.getElementById('current-depth').textContent = Math.round(data.depth);
    document.getElementById('server-time').textContent = formatDate(data.serverTime);
    document.getElementById('last-update').textContent = formatDate(data.lastUpdate);
    countdownValue = 30;
    document.getElementById('countdown').textContent = countdownValue;
  });

  socket.on('players_updated', (players) => {
    players.forEach(p => {
      if (p.username === username) {
        document.querySelector('.scales').innerHTML = '<strong>Луска:</strong> ' + p.scales.toFixed(1) + (p.alive ? '' : ' 💀');
        document.querySelector('.lost').innerHTML = '<strong>Втрачено луски:</strong> ' + p.lost_scales;
        document.querySelector('.coins').innerHTML = '<strong>Монети:</strong> ' + p.coins + ' 🪙';
        document.querySelector('.status').innerHTML = '<strong>Статус:</strong> ' + (p.alive ? 'Жива 🐉' : 'Зникла 💀');

        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = '➤ ' + p.action;
        document.getElementById('player-card').appendChild(notification);

        setTimeout(() => {
          if (notification.parentNode) notification.remove();
        }, 10000);
      }
    });
  });

  let countdownValue = 30;
  setInterval(() => {
    countdownValue = countdownValue <= 1 ? 30 : countdownValue - 1;
    document.getElementById('countdown').textContent = countdownValue;
  }, 1000);

  setInterval(() => {
    document.getElementById('server-time').textContent = new Date().toLocaleString('uk-UA', {
      timeZone: 'Europe/Kiev', hour12: false
    });
  }, 1000);

  socket.on('connect', () => {
    console.log('✅ Підключено до сервера в реальному часі');
  });
</script>


      <br>
      <a href="/" style="color: #7fffd4; font-size: 1.1em;">← Змінити ім'я / Увійти як інший гравець</a>
    </body>
    </html> 
  `;
}

