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
    origin: "*",
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
      pearls FLOAT DEFAULT 50,
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

    // === ЗАПУСК СЕРВЕРА ===
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
        for (let row of playersResult.rows) {
          let player = { ...row };
          let updated = false;
          let actionLog = `${player.username}: `;

          // Конвертуємо значення
          let pearls = parseFloat(player.pearls);
          let lostPearls = parseInt(player.lost_pearls || 0);
          let coins = parseInt(player.coins || 0);
          let lastLossDepth = player.last_loss_depth ? parseFloat(player.last_loss_depth) : null;

          // === Їсти: якщо перлин <50 і глибина достатня ===
          if (pearls < 50 && lastLossDepth !== null && newDepth > lastLossDepth * (1 + player.eat_threshold)) {
            const bonus = (newDepth - lastLossDepth) / lastLossDepth;
            const pearlGain = 1 + bonus * 2; // Зменшено з *10 на *2
            pearls = Math.min(50, pearls + pearlGain);
            updated = true;
            actionLog += `зібрав перлину на глибині (+${pearlGain.toFixed(2)} перлин) 💎 `;
          }

          // === Гуляти: якщо перлин >=50 і глибина достатньо мілка ===
          if (pearls >= 50 && (lastLossDepth === null || newDepth <= lastLossDepth * (1 - player.play_threshold))) {
            pearls -= 1;
            lostPearls += 1;
            coins += 1;
            lastLossDepth = newDepth;
            updated = true;
            actionLog += `обміняв перлину на мілководді (-1 перлина, +1 монета) 🪙 `;

            if (pearls <= 0) {
              pearls = 0;
              player.alive = false;
              player.death_time = new Date();
              actionLog += `→ ЗМІЯ СТАЛА ПЕРНАТОЮ І ВІДЛЕТІЛА З МОНЕТАМИ! 🪶💰`;
            }
          }

          // Зберігаємо зміни
          if (updated) {
            await pool.query(`
              UPDATE players 
              SET pearls = $1, 
                  lost_pearls = $2, 
                  coins = $3, 
                  last_loss_depth = $4,
                  alive = $5,
                  death_time = $6
              WHERE id = $7
            `, [
              pearls,
              lostPearls,
              coins,
              lastLossDepth,
              pearls > 0,
              pearls <= 0 ? new Date() : player.death_time,
              player.id
            ]);

            updatedPlayers.push({
              id: player.id,
              username: player.username,
              pearls: parseFloat(pearls.toFixed(2)),
              lost_pearls: lostPearls,
              coins: coins,
              alive: pearls > 0,
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

// Статичні файли та роути
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT username, coins, alive, death_time
      FROM players
      ORDER BY coins DESC
      LIMIT 10
    `);
    const players = result.rows;
    res.send(`
      <!DOCTYPE html>
      <html lang="uk">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Лідерборд - Водяна Змія</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            text-align: center; 
            margin: 50px; 
            background: #001f3f; 
            color: #fff; 
          }
          .card { 
            background: rgba(255,255,255,0.1); 
            padding: 30px; 
            border-radius: 15px; 
            display: inline-block; 
            min-width: 400px; 
          }
          h1 { color: #7fffd4; }
          table { 
            width: 100%; 
            border-collapse: collapse; 
            margin-top: 20px; 
          }
          th, td { 
            padding: 10px; 
            border: 1px solid #7fffd4; 
          }
          th { background: rgba(127,255,212,0.2); }
          .alive { color: #7fffd4; }
          .dead { color: #ff6b6b; }
        </style>
      </head>
      <body>
        <h1>🏆 Лідерборд Водяних Змій</h1>
        <div class="card">
          <h3>Топ-10 гравців за монетами</h3>
          <table>
            <tr>
              <th>Гравець</th>
              <th>Монети 🪙</th>
              <th>Статус</th>
            </tr>
            ${players.map(p => `
              <tr>
                <td>${p.username}</td>
                <td>${p.coins}</td>
                <td class="${p.alive ? 'alive' : 'dead'}">
                  ${p.alive ? 'Плаває 🐉' : 'Відлетіла 🪶' + (p.death_time ? ' (' + new Date(p.death_time).toLocaleString('uk-UA') + ')' : '')}
                </td>
              </tr>
            `).join('')}
          </table>
          <p style="margin-top: 20px;">
            <a href="/" style="color: #7fffd4;">← Повернутися до гри</a>
          </p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Помилка лідерборду:', err);
    res.send('<h2>Помилка бази даних. Спробуйте пізніше.</h2>');
  }
});

app.post('/eat', async (req, res) => {
  const { username } = req.body;
  
  try {
    const playerResult = await pool.query('SELECT * FROM players WHERE username = $1', [username]);
    const depthResult = await pool.query('SELECT current_depth FROM game_state WHERE id = 1');
    
    if (playerResult.rows.length === 0) {
      return res.json({ success: false, message: 'Гравця не знайдено' });
    }
    
    const player = playerResult.rows[0];
    const currentDepth = parseFloat(depthResult.rows[0].current_depth);
    
    // Перевірка умов
    if (!player.alive) {
      return res.json({ success: false, message: 'Змія відлетіла 🪶' });
    }
    
    if (player.pearls >= 50) {
      return res.json({ success: false, message: 'Перлин вже повно (50/50)' });
    }
    
    if (player.last_loss_depth === null) {
      return res.json({ success: false, message: 'Спочатку треба обміняти перлину' });
    }
    
    const threshold = player.last_loss_depth * (1 + player.eat_threshold);
    if (currentDepth < threshold) {
      return res.json({ 
        success: false, 
        message: `Потрібно пірнути глибше (зараз ${Math.round(currentDepth)}м, треба ≥${Math.round(threshold)}м)` 
      });
    }
    
    // Виконуємо їжу
    const bonus = (currentDepth - player.last_loss_depth) / player.last_loss_depth;
    const pearlGain = 1 + bonus;
    const newPearls = Math.min(50, parseFloat(player.pearls) + pearlGain);
    
    await pool.query(`
      UPDATE players 
      SET pearls = $1
      WHERE username = $2
    `, [newPearls, username]);
    
    // Повідомляємо всіх
    io.emit('players_updated', [{
      username: player.username,
      pearls: parseFloat(newPearls.toFixed(2)),
      lost_pearls: player.lost_pearls,
      coins: player.coins,
      alive: true,
      action: `${username}: зібрав перлину вручну (+${pearlGain.toFixed(2)} перлин) 💎`
    }]);
    
    res.json({ 
      success: true, 
      message: `Смачно! +${pearlGain.toFixed(2)} перлин 💎${newPearls >= 50 ? ' Перлини повні!' : ''}`
    });
    
  } catch (err) {
    console.error('Помилка в /eat:', err);
    res.json({ success: false, message: 'Помилка сервера' });
  }
});

app.post('/walk', async (req, res) => {
  const { username } = req.body;
  
  try {
    const playerResult = await pool.query('SELECT * FROM players WHERE username = $1', [username]);
    const depthResult = await pool.query('SELECT current_depth FROM game_state WHERE id = 1');
    
    if (playerResult.rows.length === 0) {
      return res.json({ success: false, message: 'Гравця не знайдено' });
    }
    
    const player = playerResult.rows[0];
    const currentDepth = parseFloat(depthResult.rows[0].current_depth);
    
    // Перевірка умов
    if (!player.alive) {
      return res.json({ success: false, message: 'Змія відлетіла 🪶' });
    }
    
    if (player.pearls < 50) {
      return res.json({ success: false, message: 'Недостатньо перлин для обміну' });
    }
    
    const threshold = player.last_loss_depth ? player.last_loss_depth * (1 - player.play_threshold) : currentDepth;
    if (currentDepth > threshold) {
      return res.json({ 
        success: false, 
        message: `Потрібно піднятися вище (зараз ${Math.round(currentDepth)}м, треба ≤${Math.round(threshold)}м)` 
      });
    }
    
    // Виконуємо обмін
    const newPearls = player.pearls - 1;
    const newLostPearls = player.lost_pearls + 1;
    const newCoins = player.coins + 1;
    const alive = newPearls > 0;
    
    await pool.query(`
      UPDATE players 
      SET pearls = $1, 
          lost_pearls = $2, 
          coins = $3, 
          last_loss_depth = $4,
          alive = $5,
          death_time = CASE WHEN $5 = false THEN NOW() ELSE death_time END
      WHERE username = $6
    `, [newPearls, newLostPearls, newCoins, currentDepth, alive, username]);
    
    // Повідомляємо всіх
    io.emit('players_updated', [{
      username: player.username,
      pearls: parseFloat(newPearls.toFixed(2)),
      lost_pearls: newLostPearls,
      coins: newCoins,
      alive: alive,
      action: `${username}: обміняв перлину вручну (-1 перлина, +1 монета)${!alive ? ' → ЗМІЯ СТАЛА ПЕРНАТОЮ І ВІДЛЕТІЛА! 🪶💰' : ''}`
    }]);
    
    res.json({ 
      success: true, 
      message: alive ? 'Обмін успішний! -1 перлина, +1 монета 🪙' : 'Остання перлина... Змія стала пернатою і відлетіла! 🪶💰'
    });
    
  } catch (err) {
    console.error('Помилка в /walk:', err);
    res.json({ success: false, message: 'Помилка сервера' });
  }
});

app.post('/join', async (req, res) => {
  const username = req.body.username.trim();
  
  if (!username || username.length < 2 || username.length > 20) {
    return res.send(`
      <h2>Помилка: Ім'я має бути від 2 до 20 символів</h2>
      <a href="/">Спробувати ще раз</a>
    `);
  }

  try {
    let result = await pool.query('SELECT * FROM players WHERE username = $1', [username]);

    if (result.rows.length > 0) {
      const player = result.rows[0];
      res.send(generatePlayerPage(player, false));
    } else {
      result = await pool.query(`
        INSERT INTO players 
        (username, pearls, lost_pearls, coins, last_loss_depth, alive, start_time)
        VALUES ($1, 50, 0, 0, NULL, true, NOW())
        RETURNING *
      `, [username]);

      const newPlayer = result.rows[0];
      res.send(generatePlayerPage(newPlayer, true));
    }
  } catch (err) {
    console.error(err);
    res.send('<h2>Помилка бази даних. Спробуйте пізніше.</h2>');
  }
});

function generatePlayerPage(player, isNew) {
   // Безпечне форматування чисел
  const pearls = player.pearls != null ? parseFloat(player.pearls).toFixed(1) : '0.0';
  const lostPearls = player.lost_pearls || 0;
  const coins = player.coins || 0;
  const alive = player.alive || false;

  const welcomeMsg = isNew 
    ? `<h2 style="color:green;">Вітаємо, ${player.username}! Твоя водяна змія пірнає за перлинами!</h2>`
    : `<h2>З поверненням, ${player.username}!</h2>`;

  return `
    <!DOCTYPE html>
    <html lang="uk">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Водяна Змія - ${player.username}</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          text-align: center; 
          margin: 50px; 
          background: #001f3f; 
          color: #fff; 
        }
        .card { 
          background: rgba(255,255,255,0.1); 
          padding: 30px; 
          border-radius: 15px; 
          display: inline-block; 
          min-width: 400px; 
          margin: 10px auto; 
        }
        h1 { color: #7fffd4; }
        #current-depth { font-size: 1.5em; font-weight: bold; color: #7fffd4; }
        .notification { 
          color: #7fffd4; 
          font-style: italic; 
          margin-top: 10px; 
          animation: fadeIn 0.5s;
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .dead { color: #ff6b6b; }
      </style>
    </head>
      <body>
      <h1>🐍 Водяна Змія</h1>
      ${welcomeMsg}

      <div class="card" id="player-card">
        <p class="pearls"><strong>Перлини:</strong> ${pearls} 💎${!alive ? ' 🪶' : ''}</p>
        <p class="lost"><strong>Обміняно перлин:</strong> ${lostPearls}</p>
        <p class="coins"><strong>Монети:</strong> ${coins} 🪙</p>
        <p class="status"><strong>Статус:</strong> ${alive ? 'Пірнає 🐉' : '<span class="dead">Відлетіла 🪶</span>'}</p>
        
        <button id="walk-btn" style="
          margin-top: 15px;
          padding: 10px 20px;
          background: #7fffd4;
          color: #001f3f;
          border: none;
          border-radius: 8px;
          font-size: 1.1em;
          cursor: pointer;
          font-weight: bold;
        ">🪙 Обміняти перлину</button>
        <p id="walk-status" style="font-size: 0.9em; color: #aaa; margin-top: 10px;"></p>
        
        <button id="eat-btn" style="
          margin-top: 15px;
          margin-left: 10px;
          padding: 10px 20px;
          background: #ff6b9d;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 1.1em;
          cursor: pointer;
          font-weight: bold;
        ">💎 Збирати перлини</button>
        <p id="eat-status" style="font-size: 0.9em; color: #aaa; margin-top: 5px;"></p>
        
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

      <p><a href="/leaderboard" style="color: #7fffd4; font-size: 1.1em;">🏆 Переглянути лідерборд</a></p>

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
              const isDead = !p.alive;
              document.querySelector('.pearls').innerHTML = '<strong>Перлини:</strong> ' + p.pearls.toFixed(1) + ' 💎' + (isDead ? ' 🪶' : '');
              document.querySelector('.lost').innerHTML = '<strong>Обміняно перлин:</strong> ' + p.lost_pearls;
              document.querySelector('.coins').innerHTML = '<strong>Монети:</strong> ' + p.coins + ' 🪙';
              document.querySelector('.status').innerHTML = '<strong>Статус:</strong> ' + (p.alive ? 'Пірнає 🐉' : '<span class="dead">Відлетіла 🪶</span>');

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

        socket.on('disconnect', () => {
          console.log('❌ Відключено від сервера');
        });

        document.getElementById('walk-btn').addEventListener('click', () => {
          const btn = document.getElementById('walk-btn');
          const status = document.getElementById('walk-status');
          
          btn.disabled = true;
          status.textContent = 'Перевіряємо умови...';
          
          fetch('/walk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username })
          })
          .then(res => res.json())
          .then(data => {
            if (data.success) {
              status.style.color = '#7fffd4';
              status.textContent = '✓ ' + data.message;
            } else {
              status.style.color = '#ff6b6b';
              status.textContent = '✗ ' + data.message;
            }
            setTimeout(() => { btn.disabled = false; }, 2000);
          })
          .catch(err => {
            status.style.color = '#ff6b6b';
            status.textContent = 'Помилка зв’язку';
            btn.disabled = false;
          });
        });

        document.getElementById('eat-btn').addEventListener('click', () => {
          const btn = document.getElementById('eat-btn');
          const status = document.getElementById('eat-status');
          
          btn.disabled = true;
          status.textContent = 'Перевіряємо умови...';
          
          fetch('/eat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username })
          })
          .then(res => res.json())
          .then(data => {
            if (data.success) {
              status.style.color = '#7fffd4';
              status.textContent = '✓ ' + data.message;
            } else {
              status.style.color = '#ff6b6b';
              status.textContent = '✗ ' + data.message;
            }
            setTimeout(() => { btn.disabled = false; }, 2000);
          })
          .catch(err => {
            status.style.color = '#ff6b6b';
            status.textContent = 'Помилка зв’язку';
            btn.disabled = false;
          });
        });
      </script>

      <br>
      <a href="/" style="color: #7fffd4; font-size: 1.1em;">← Змінити ім'я / Увійти як інший гравець</a>
    </body>
    </html> 
  `;
}
