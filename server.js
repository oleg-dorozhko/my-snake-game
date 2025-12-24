const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Підключення до PostgreSQL на Render (автоматично додає змінну DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// === Перевірка підключення до БД при старті ===
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

// Викликаємо перевірку і тільки після успіху запускаємо сервер
checkDatabaseConnection()
  .then(() => {
    // Створюємо таблицю players
    return pool.query(`
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
    `);
  })
  .then(() => {
    console.log('📊 Таблиця players готова або вже існує');

    // Створюємо таблицю game_state
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

    // Ініціалізуємо рядок з глибиною, якщо його ще немає
    return pool.query(`
      INSERT INTO game_state (id, current_depth)
      VALUES (1, 500)
      ON CONFLICT (id) DO NOTHING
    `);
  })
  .then(() => {
    console.log('🌊 Глобальна глибина ініціалізована (500 м)');

    // === ТЕПЕР ЗАПУСКАЄМО СЕРВЕР ===
    app.listen(port, () => {
      console.log(`🚀 Сервер запущено на порту ${port}`);
      console.log(`Відкрий: https://твій-сервіс.onrender.com`);
    });

    // === Запускаємо зміну глибини кожні 30 секунд ===
    setInterval(async () => {
      try {
        const rand = Math.random();
        let depthChange = 0;
        if (rand < 0.17) depthChange = 50;         // глибше
        else if (rand < 0.34) depthChange = -50;   // вище
        // інакше 66% — без змін

        const result = await pool.query(`
          UPDATE game_state 
          SET current_depth = current_depth + $1,
              last_update = NOW()
          WHERE id = 1
          RETURNING current_depth
        `, [depthChange]);

        const newDepth = result.rows[0].current_depth;
        console.log(`🌊 Глибина оновлена: ${newDepth.toFixed(0)} м (зміна: ${depthChange >= 0 ? '+' : ''}${depthChange} м)`);
      } catch (err) {
        console.error('Помилка оновлення глибини:', err);
      }
    }, 30000); // кожні 30 секунд
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

// API для отримання поточної глибини
app.get('/api/depth', async (req, res) => {
  try {
    const result = await pool.query('SELECT current_depth FROM game_state WHERE id = 1');
    if (result.rows.length > 0) {
      res.json({ depth: result.rows[0].current_depth });
    } else {
      res.status(500).json({ error: 'Глибина не ініціалізована' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Обробка введення імені
app.post('/join', async (req, res) => {
  const username = req.body.username.trim();

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

// Функція для генерації HTML-сторінки з даними гравця
function generatePlayerPage(player, isNew) {
  const welcomeMsg = isNew 
    ? `<h2 style="color:green;">Вітаємо, ${player.username}! Твоя водяна змія готова до пригод!</h2>`
    : `<h2>З поверненням, ${player.username}!</h2>`;

  return `
    <!DOCTYPE html>
    <html lang="uk">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Водяна Змія</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; margin: 50px; background: #001f3f; color: #fff; }
        .card { background: rgba(255,255,255,0.1); padding: 30px; border-radius: 15px; display: inline-block; min-width: 400px; }
        h1 { color: #7fffd4; }
      </style>
    </head>
    <body>
      <h1>🐍 Водяна Змія</h1>
      ${welcomeMsg}
      <div class="card">
        <p><strong>Луска:</strong> ${player.scales.toFixed(1)}</p>
        <p><strong>Втрачено луски:</strong> ${player.lost_scales}</p>
        <p><strong>Монети:</strong> ${player.coins}</p>
        <p><strong>Статус:</strong> ${player.alive ? 'Жива' : 'Зникла'}</p>
        <p><small>Гра запущена: ${new Date(player.start_time).toLocaleString('uk-UA')}</small></p>
      </div>
      <br>
      <p>Глобальний потік глибини: <strong>ще не запущений</strong> (буде в наступній версії)</p>
      <br>
      <a href="/">Змінити ім'я (увійти як інший гравець)</a>
    </body>
    </html>
  `;
}

