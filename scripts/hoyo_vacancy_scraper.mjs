import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FACILITY_NAME = '箱根 大平台みなと荘';
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'data', 'hakone_vacancy.json');

export function formatDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function getJapaneseHolidaySet() {
  const holidays = new Set([
    '2025-01-01', '2025-01-13', '2025-02-11', '2025-02-12', '2025-02-23', '2025-03-20', '2025-03-21', '2025-04-29', '2025-05-03', '2025-05-04', '2025-05-05', '2025-05-06', '2025-07-21', '2025-08-11', '2025-09-15', '2025-09-23', '2025-10-13', '2025-11-03', '2025-11-23', '2025-12-23',
    '2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-10-12', '2026-11-03', '2026-11-23', '2026-12-23',
    '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-20', '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19', '2027-08-11', '2027-09-20', '2027-10-11', '2027-11-03', '2027-11-23', '2027-12-23',
  ]);
  return holidays;
}

export function classifyVacancyDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  const isSaturday = date.getDay() === 6;
  const tomorrow = addDays(date, 1);
  const holidaySet = getJapaneseHolidaySet();
  const isHolidayEve = holidaySet.has(formatDate(tomorrow));

  if (isSaturday || isHolidayEve) {
    return '土曜・祝前日';
  }

  return 'その他日';
}

export function isTargetDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const oneMonthLater = addDays(today, 30);
  if (date < today || date > oneMonthLater) {
    return false;
  }

  return true;
}

export function normalizeStatus(status = '') {
  return String(status)
    .replace(/[\s\u00A0]+/g, '')
    .replace(/／/g, '/');
}

export function isOpenStatus(status) {
  const normalized = normalizeStatus(status);
  if (!normalized) {
    return false;
  }

  if (normalized.includes('予約あり')) {
    return false;
  }

  if (normalized.includes('空き')) {
    return true;
  }

  return ['全て空き', '一部空き', '空きあり'].includes(normalized);
}

export function getStoreState(rawContent = '') {
  if (!rawContent || !rawContent.trim()) {
    return { records: [], lastNotified: {}, flags: {}, lastCheckedAt: null };
  }

  try {
    const parsed = JSON.parse(rawContent);
    if (Array.isArray(parsed)) {
      return { records: parsed, lastNotified: {}, flags: {}, lastCheckedAt: null };
    }

    if (parsed && Array.isArray(parsed.records)) {
      return {
        records: parsed.records,
        lastNotified: parsed.lastNotified || {},
        flags: parsed.flags || {},
        lastCheckedAt: parsed.lastCheckedAt || null,
      };
    }
  } catch (error) {
    console.warn('Unable to parse previous vacancy state, restarting from empty snapshot.', error.message);
  }

  return { records: [], lastNotified: {}, flags: {}, lastCheckedAt: null };
}

export function computeNewAlerts(filtered, previousState = { records: [], lastNotified: {}, flags: {} }) {
  const previousFlags = previousState.flags || {};
  const currentFlags = Object.fromEntries(filtered.map((record) => [`${record.date}|${normalizeStatus(record.status)}`, true]));

  const opened = filtered.filter((record) => {
    const key = `${record.date}|${normalizeStatus(record.status)}`;
    return !previousFlags[key] || previousFlags[key] === false;
  }).map((record) => ({ ...record, kind: 'opened' }));

  const closed = Object.entries(previousFlags)
    .filter(([key, value]) => value === true && !(key in currentFlags))
    .map(([key]) => {
      const [date, status] = key.split('|');
      return {
        date,
        status: status || '未定義',
        facility: FACILITY_NAME,
        kind: 'closed',
      };
    });

  return [...opened, ...closed];
}

function getTokyoNow() {
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  return new Date(utcMs + (9 * 60 * 60 * 1000));
}

function shouldRunDuringServiceWindow() {
  const hour = getTokyoNow().getHours();
  return hour >= 5 && hour <= 23;
}

function getEmailConfig() {
  return {
    smtpUser: process.env.EMAIL_USER || process.env.GMAIL_USER || process.env.SMTP_USER,
    smtpPassword: process.env.EMAIL_PASSWORD || process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASSWORD,
    recipient: process.env.ALERT_EMAIL || process.env.EMAIL_TO || process.env.NOTIFY_EMAIL,
  };
}

async function sendEmailNotification(alerts) {
  const { smtpUser, smtpPassword, recipient } = getEmailConfig();

  if (!smtpUser || !smtpPassword || !recipient) {
    console.error('Email SMTP settings are not configured. Required: EMAIL_USER/GMAIL_USER/SMTP_USER, EMAIL_PASSWORD/GMAIL_APP_PASSWORD/SMTP_PASSWORD, ALERT_EMAIL/EMAIL_TO/NOTIFY_EMAIL. Skipping email notification.');
    return;
  }

  const isVerificationRun = alerts.some((record) => (record.category || '').includes('自動実行確認') || String(record.status || '').includes('自動実行確認'));
  const subject = isVerificationRun ? `自動実行確認メール (${alerts.length}件)` : `空き状態が変化しました (${alerts.length}件)`;
  const sections = ['土曜・祝前日', 'その他日', '自動実行確認'].map((category) => {
    const items = alerts.filter((record) => (record.category || classifyVacancyDate(record.date)) === category);
    if (items.length === 0) {
      return null;
    }

    const lines = items.map((record) => {
      const label = record.kind === 'closed' ? '埋まり' : '空き';
      return `- ${record.date} ${record.status} (${label}) ${record.facility}`;
    });
    return `${category}\n${lines.join('\n')}`;
  }).filter(Boolean);

  const message = sections.length > 0 ? sections.join('\n\n') : alerts.map((record) => `${record.date} ${record.status} (${record.kind === 'closed' ? '埋まり' : '空き'}) ${record.facility}`).join('\n');

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
      text: `空き状況が変化しました。\n\n${message}`,
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

    const facilitySearchLink = page.locator('a[href*="gRsvWTransInstSrchVacantAction"]');
    if ((await facilitySearchLink.count()) === 0) {
      throw new Error('Facility search link missing on the Hoyo landing page.');
    }

    await facilitySearchLink.click();
    await page.waitForURL(/rsvWTransInstSrchBuildAction\.do/, { timeout: 30000 });

    const facilitySelected = await page.evaluate(({ code }) => {
      if (typeof sendBldCd === 'function') {
        sendBldCd(document.form1, gRsvWTransInstSrchInstAction, code);
        return true;
      }

      const anchor = Array.from(document.querySelectorAll('a')).find((element) => {
        const text = ((element.textContent || '').replace(/\s+/g, ' ').trim());
        return text.includes('箱根') && text.includes('大平台');
      });

      if (anchor) {
        anchor.click();
        return true;
      }

      return false;
    }, { code: '1000' });

    if (!facilitySelected) {
      throw new Error('Target facility link not found on the Hoyo facility selection page.');
    }

    await page.waitForURL(/rsvWTransInstSrchInstAction\.do/, { timeout: 30000 });

    const rows = await page.evaluate(({ facilityName }) => {
      const normalizeCellStatus = (status = '') => String(status).replace(/[\s\u00A0]+/g, '');
      const results = [];
      const monthTables = [...document.querySelectorAll('table.m_akitablelist')];
      const targetTables = monthTables.length > 0 ? monthTables : [...document.querySelectorAll('table')].filter((table) => {
        const caption = (table.querySelector('caption')?.textContent || '').replace(/\s+/g, '');
        const text = (table.textContent || '').replace(/\s+/g, '');
        return caption.includes('空き室状況') || text.includes('空き室状況');
      });

      for (const targetTable of targetTables) {
        let currentYear = null;
        let currentMonth = null;

        for (const row of targetTable.querySelectorAll('tr')) {
          const cells = [...row.querySelectorAll('th, td')];
          const joinedText = cells.map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim()).join(' ');
          const monthMatch = joinedText.match(/(\d{4})年(\d{1,2})月/);
          if (monthMatch) {
            currentYear = Number(monthMatch[1]);
            currentMonth = Number(monthMatch[2]);
            continue;
          }

          for (const cell of cells) {
            const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
            const dayMatch = text.match(/^(\d{1,2})日/);
            if (!dayMatch || currentYear === null || currentMonth === null) {
              continue;
            }

            const image = cell.querySelector('img');
            const status = normalizeCellStatus(image?.getAttribute('alt') || text.replace(/^(\d{1,2})日\s*/, ''));
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
      }

      return results;
    }, { facilityName: FACILITY_NAME });

    return rows.filter((row) => row.date && row.status);
  } finally {
    await browser.close();
  }
}

async function main() {
  if (!shouldRunDuringServiceWindow() && process.env.FORCE_EMAIL_TEST !== 'true') {
    console.log('Outside service hours (05:00-24:00). Continuing with the last-run audit only.');
  }

  const previousRaw = await fs.readFile(OUTPUT_PATH, 'utf8').catch(() => '[]');
  const previousState = getStoreState(previousRaw);
  const currentRecords = (await scrapeVacancy()).filter((record) => isTargetDate(record.date));
  const filtered = currentRecords.filter((record) => isOpenStatus(record.status));

  if (filtered.length > 0) {
    console.log('Currently open dates:', filtered.map((record) => `${record.date} ${record.status}`).join(', '));
  } else {
    console.log('Currently open dates: none');
  }

  const alertCandidates = computeNewAlerts(filtered, previousState).map((record) => ({
    ...record,
    category: classifyVacancyDate(record.date),
  }));

  const hasEmailConfig = Boolean(getEmailConfig().smtpUser && getEmailConfig().smtpPassword && getEmailConfig().recipient);

  let newAlerts = alertCandidates;
  if (process.env.FORCE_EMAIL_TEST === 'true' || process.env.FORCE_LINE_TEST === 'true') {
    const today = new Date();
    const nextSaturday = new Date(today);
    nextSaturday.setHours(0, 0, 0, 0);
    while (nextSaturday.getDay() !== 6) {
      nextSaturday.setDate(nextSaturday.getDate() + 1);
    }

    const otherDate = addDays(nextSaturday, 2);
    const weekendDate = formatDate(nextSaturday);
    const otherDateString = formatDate(otherDate);

    newAlerts = [
      { facility: 'テスト送信', date: weekendDate, status: '全て空き', category: '土曜・祝前日' },
      { facility: 'テスト送信', date: otherDateString, status: '一部空き', category: 'その他日' },
    ];
    console.log('FORCE_EMAIL_TEST=true: sending a test email alert with both sections.');

    if (!hasEmailConfig) {
      console.error('Test email requested but SMTP credentials are missing. Add EMAIL_USER/EMAIL_PASSWORD and ALERT_EMAIL in GitHub Actions secrets.');
      process.exitCode = 1;
    }
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });

  const nextFlags = Object.fromEntries(filtered.map((record) => [`${record.date}|${normalizeStatus(record.status)}`, true]));
  const nowIso = new Date().toISOString();

  const stateToPersist = {
    records: currentRecords,
    lastNotified: {},
    flags: nextFlags,
    lastCheckedAt: nowIso,
    runSource: process.env.GITHUB_ACTIONS ? 'github-actions' : 'manual',
    workflowTrigger: process.env.GITHUB_EVENT_NAME || 'manual',
  };
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(stateToPersist, null, 2), 'utf8');

  console.log(`Last successful scan at ${nowIso}`);
  console.log(`Run source: ${stateToPersist.runSource}`);

  if (newAlerts.length > 0) {
    console.log('Vacancy alerts detected:');
    newAlerts.forEach((record) => console.log(`${record.date} ${record.status} ${record.category} ${record.facility}`));
    await sendEmailNotification(newAlerts);
  } else {
    console.log(`No open vacancies currently detected in the next month. ${filtered.length} open dates checked.`);
  }

  console.log(`Saved ${currentRecords.length} records to ${OUTPUT_PATH}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error('Hoyo monitor failed:', error);
    process.exitCode = 1;
  });
}

export { main, scrapeVacancy };
