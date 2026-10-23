#!/usr/bin/env node

/**
 * Antigravity Telegram Notifier - Test Ping
 * Sends a test ping notification to verify Cloudflare Worker and Telegram Bot connectivity.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function loadConfig() {
  const homeConfigPath = path.join(os.homedir(), '.antigravity-telegram.json');
  if (fs.existsSync(homeConfigPath)) {
    try {
      return JSON.parse(fs.readFileSync(homeConfigPath, 'utf8'));
    } catch (_) {}
  }

  const localConfigPath = path.resolve(import.meta.dirname || path.dirname(process.argv[1]), '../config.json');
  if (fs.existsSync(localConfigPath)) {
    try {
      return JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
    } catch (_) {}
  }

  if (process.env.ANTIGRAVITY_TELEGRAM_WORKER_URL) {
    return {
      workerUrl: process.env.ANTIGRAVITY_TELEGRAM_WORKER_URL,
      authSecret: process.env.ANTIGRAVITY_TELEGRAM_AUTH_SECRET || '',
      enabled: true
    };
  }

  return null;
}

async function run() {
  console.log('🔍 Kiểm tra cấu hình Antigravity Telegram Notifier...');
  const config = loadConfig();

  if (!config || !config.workerUrl) {
    console.error('❌ Không tìm thấy cấu hình hoặc thiếu workerUrl!');
    console.error('👉 Vui lòng chạy "npm run setup" hoặc tạo file ~/.antigravity-telegram.json');
    process.exit(1);
  }

  console.log(`🌐 Target Worker URL: ${config.workerUrl}`);
  console.log('📡 Đang gửi tin nhắn thử nghiệm (Test Ping)...');

  const testPayload = {
    workspace: 'Antigravity Workspace (Test)',
    prompt: 'Kiểm tra kết nối Antigravity Task Notifier',
    summary: '🎉 Xin chúc mừng! Cấu hình Cloudflare Worker và Telegram Bot đã hoạt động hoàn hảo!',
    status: 'NO_TOOL_CALL',
    model: 'Gemini 3.8 Flash',
    artifacts: ['telegram_task_notifier_plan.md'],
    durationSeconds: 3,
    conversationId: 'test-ping-' + Date.now()
  };

  const headers = { 'Content-Type': 'application/json' };
  if (config.authSecret) {
    headers['Authorization'] = `Bearer ${config.authSecret}`;
  }

  try {
    const res = await fetch(config.workerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(testPayload)
    });

    const result = await res.json();
    if (res.ok && result.success) {
      console.log('✅ THÀNH CÔNG! Tin nhắn test đã được gửi tới Telegram!');
      console.log(`   Message ID: ${result.messageId}`);
    } else {
      console.error('❌ Thất bại:', result.error || res.statusText);
    }
  } catch (err) {
    console.error('❌ Lỗi kết nối tới Worker:', err.message);
  }
}

run();
