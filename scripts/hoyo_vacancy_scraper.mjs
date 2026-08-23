import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FACILITY_NAME = '箱根 大平台みなと荘';
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'data', 'hakone_vacancy.json');

function formatDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getJapaneseHolidaySet(year) {
  const holidays = new Set([
    '2025-01-01', '2025-01-13', '2025-02-11', '2025-02-12', '2025-02-23', '2025-03-20', '2025-03-21', '2025-04-29', '2025-05-03', '2025-05-04', '2025-05-05', '2025-05-06', '2025-07-21', '2025-08-11', '2025-09-15', '2025-09-23', '2025-10-13', '2025-11-03', '2025-11-23', '2025-12-23',
    '2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-10-12', '2026-11-03', '2026-11-23', '2026-12-23',
    '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-20', '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19', '2027-08-11', '2027-09-20', '2027-10-11', '2027-11-03', '2027-11-23', '2027-12-23',
  ]);
  return holidays;
}

function isTargetDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const oneMonthLater = addDays(today, 30);
  if (date < today || date > oneMonthLater) {
    return false;
  }

  const isSaturday = date.getDay() === 6;
  const tomorrow = addDays(date, 1);
  const holidaySet = getJapaneseHolidaySet(date.getFullYear());
  const isHolidayEve = holidaySet.has(formatDate(tomorrow));

  return isSaturday || isHolidayEve;
}

function isOpenStatus(status) {
  return ['全て空き', '一部空き'].includes(status);
}

function getEmailConfig() {
  return {
    smtpUser: process.env.EMAIL_USER || process.env.GMAIL_USER,
    smtpPassword: process.env.EMAIL_PASSWORD || process.env.GMAIL_APP_PASSWORD,
    recipient: process.env.ALERT_EMAIL || process.env.EMAIL_TO,
  };
}

async function sendEmailNotification(alerts) {
  const { smtpUser, smtpPassword, recipient } = getEmailConfig();

  if (!smtpUser || !smtpPassword || !recipient) {
    console.error('Email SMTP settings are not configured. Required: EMAIL_USER/GMAIL_USER, EMAIL_PASSWORD/GMAIL_APP_PASSWORD, ALERT_EMAIL. Skipping email notification.');
    return;
  }

  const subject = `空き日が見つかりました (${alerts.length}件)`;
  const message = alerts
    .map((record) => `${record.date} ${record.status} (${record.facility})`)
    .join('\n');

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: smtpUser,
        pass: smtpPassword,
      },
    });

    await transporter.sendMail({
      from: smtpUser,
      to: recipient,
      subject,
      text: `空き日程の通知です。\n\n${message}`,
    });

    console.log('Email notification sent successfully.');
  } catch (error) {
    console.warn('Email notification error:', error.message);
  }
}

async function scrapeVacancy() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });

  try {
    await page.goto('https://hoyo.city.minato.tokyo.jp/hoyo/web/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.locator('a[href*="gRsvWTransInstSrchVacantAction"]').click();
    await page.waitForURL(/rsvWTransInstSrchBuildAction\.do/, { timeout: 30000 });

    await page.locator('a[href*="sendBldCd"]').nth(1).click();
    await page.waitForURL(/rsvWTransInstSrchInstAction\.do/, { timeout: 30000 });

    const rows = await page.evaluate(({ facilityName }) => {
      const results = [];
      const cells = [...document.querySelectorAll('td')];
      let currentYear = null;
      let currentMonth = null;

      for (const cell of cells) {
        const className = cell.getAttribute('class') || '';
        const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();

        if (className.includes('m_akitablelist') && text && /\d{4}年\d{1,2}月/.test(text)) {
          const monthMatch = text.match(/(\d{4})年(\d{1,2})月/);
          if (monthMatch) {
            currentYear = Number(monthMatch[1]);
            currentMonth = Number(monthMatch[2]);
          }
        }

        if (className.includes('m_akitablelist_') && text && /\d{1,2}日/.test(text)) {
          const dayMatch = text.match(/(\d{1,2})日/);
          if (!dayMatch || currentYear === null || currentMonth === null) {
            continue;
          }

          const image = cell.querySelector('img');
          const status = (image?.getAttribute('alt') || '').trim();
          if (!status) {
            continue;
          }

          results.push({
            facility: facilityName,
            date: `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(Number(dayMatch[1])).padStart(2, '0')}`,
            status,
          });
        }
      }

      return results;
    }, { facilityName: FACILITY_NAME });

    return rows.filter((row) => row.date && row.status);
  } finally {
    await browser.close();
  }
}

const previous = await fs.readFile(OUTPUT_PATH, 'utf8').catch(() => '[]');
const previousRecords = JSON.parse(previous);
const currentRecords = await scrapeVacancy();
const filtered = currentRecords.filter((record) => isTargetDate(record.date));
const previousSet = new Set(previousRecords.map((record) => `${record.date}|${record.status}`));
let newAlerts = filtered.filter((record) => isOpenStatus(record.status) && !previousSet.has(`${record.date}|${record.status}`));

const hasEmailConfig = Boolean(getEmailConfig().smtpUser && getEmailConfig().smtpPassword && getEmailConfig().recipient);

if (process.env.FORCE_EMAIL_TEST === 'true' || process.env.FORCE_LINE_TEST === 'true') {
  const testDate = formatDate(addDays(new Date(), 7));
  newAlerts = [{ facility: 'テスト送信', date: testDate, status: '全て空き' }];
  console.log('FORCE_EMAIL_TEST=true: sending a test email alert.');

  if (!hasEmailConfig) {
    console.error('Test email requested but SMTP credentials are missing. Add EMAIL_USER/EMAIL_PASSWORD and ALERT_EMAIL in GitHub Actions secrets.');
    process.exitCode = 1;
  }
}

await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await fs.writeFile(OUTPUT_PATH, JSON.stringify(currentRecords, null, 2), 'utf8');

if (newAlerts.length > 0) {
  console.log('Vacancy alerts detected:');
  newAlerts.forEach((record) => console.log(`${record.date} ${record.status} ${record.facility}`));
  await sendEmailNotification(newAlerts);
} else {
  console.log(`No new Saturday/holiday-eve vacancies in the next month. ${filtered.length} relevant dates checked.`);
}

console.log(`Saved ${currentRecords.length} records to ${OUTPUT_PATH}`);
