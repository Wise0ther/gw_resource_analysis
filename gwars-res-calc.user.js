// ==UserScript==
// @name         GWars - Калькулятор Торговли Ресурсами
// @namespace    http://tampermonkey.net/
// @version      3.1.0
// @description  Автоматический сбор протоколов передач и калькулятор прибыли ТОЛЬКО по ресурсам
// @author       You
// @match        *://www.gwars.io/transfers.php?user_id=*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 1. УТИЛИТЫ И КОНСТАНТЫ
    // ==========================================
    const GW_Utils = {
        LICENSES: {
            '0': 0,
            '1': 9600,
            '7': 55200,
            '30': 168000
        },

        dateToId(s) {
            if (!s) return 0;
            return parseInt("20" + s.trim().split('.').reverse().join(''), 10);
        },

        parseDate(dateStr) {
            if (!dateStr) return new Date(0);
            const [d, t] = dateStr.trim().split(' ');
            const [day, month, year] = d.split('.');
            const [hours, minutes, seconds] = t ? t.split(':') : ['00', '00', '00'];
            return new Date(`20${year}-${month}-${day}T${hours}:${minutes}:${seconds || '00'}`);
        }
    };

    // ==========================================
    // 2. МОДУЛЬ ПАРСИНГА (ТОЛЬКО РЕСУРСЫ)
    // ==========================================
    const GW_Parser = {
        parseHtmlText(htmlText, dStartId, dEndId) {
            let extracted = [];
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = htmlText;

            const entries = tempDiv.innerText.replace(/\u00a0/g, ' ').split(/(\d{2}\.\d{2}\.\d{2}\s\d{2}:\d{2}(?::\d{2})?)/);
            let stopScan = false;

            for (let i = 1; i < entries.length; i += 2) {
                const fullDateStr = entries[i];
                const dateOnly = fullDateStr.split(' ')[0];
                const curId = GW_Utils.dateToId(dateOnly);

                if (curId > dStartId) continue;
                if (curId < dEndId) {
                    stopScan = true;
                    break;
                }

                const content = entries[i+1] || "";

                if (content.includes('продал') || content.includes('купил')) {
                    // Парсим ТОЛЬКО ресурсы (включая предметы с маркером (р), уран, руду и т.д.)
                    // Пример: продал 5 HAWK 97 (р) за 225000 Гб (45000 Гб/ед.)
                    const resourceRegex = /(купил|продал)\s+(\d+)\s+(.+?)\s+за\s+(\d+)\s+Гб\s+\((\d+)\s+Гб\/ед\.\)/i;
                    let matchRes = content.match(resourceRegex);

                    if (matchRes) {
                        extracted.push({
                            date: fullDateStr.trim(),
                            type: matchRes[1].toLowerCase(),
                            count: parseInt(matchRes[2], 10),
                            resource: matchRes[3].trim(),
                            sum: parseInt(matchRes[4], 10),
                            pricePerUnit: parseInt(matchRes[5], 10)
                        });
                    }
                }
            }

            return { logs: extracted, stopScan };
        }
    };

    // ==========================================
    // 3. ХРАНИЛИЩЕ ДАННЫХ И НАСТРОЙКИ
    // ==========================================

    function getUserId() {
        // 1. Из URL параметров (?user_id=XXXXX)
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('user_id')) {
            return urlParams.get('user_id');
        }

        // 2. Из ссылок протокола передач (<a href="/transfers.php?user_id=1715558">)
        const transferLink = document.querySelector('a[href*="transfers.php?user_id="]');
        if (transferLink) {
            const match = transferLink.href.match(/user_id=(\d+)/);
            if (match) return match[1];
        }

        // 3. Из ссылки на профиль персонажа в меню/шапке (<a href="/info.php?id=1715558">)
        const profileLink = document.querySelector('a[href*="info.php?id="]');
        if (profileLink) {
            const match = profileLink.href.match(/id=(\d+)/);
            if (match) return match[1];
        }

        // 4. Если ID так и не найден — прерываем работу скрипта
        alert("⚠️ Ошибка калькулятора GWars: не удалось определить ID игрока. Убедитесь, что вы авторизованы.");
        throw new Error("GWars Калькулятор: критическая ошибка — user_id не найден.");
    }

    const userId = getUserId();
    const dbKey = `gw_res_logs_${userId}`;
    const settingsKey = `gw_res_settings_${userId}`;

    // Генерация актуального месяца по умолчанию
    function getDefaultDates() {
        const now = new Date();
        const year = String(now.getFullYear()).slice(-2);
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

        return {
            dateFrom: `01.${month}.${year}`,
            dateTo: `${lastDay}.${month}.${year}`
        };
    }

    const defaultSettings = {
        license: '0',
        transportActive: false,
        transportCost: 0,
        ...getDefaultDates()
    };

    // Инициализация базы и слияние настроек
    if (!localStorage.getItem(dbKey)) {
        localStorage.setItem(dbKey, JSON.stringify([]));
    }

    let savedSettings = {};
    try {
        savedSettings = JSON.parse(localStorage.getItem(settingsKey)) || {};
    } catch (e) {
        console.error("Ошибка чтения настроек из localStorage:", e);
    }

    let settings = { ...defaultSettings, ...savedSettings };
    localStorage.setItem(settingsKey, JSON.stringify(settings));
    // ==========================================
    // 4. СКАНИРОВАНИЕ
    // ==========================================
    async function startAutoScan() {
        const statusEl = document.getElementById('scan_status');
        if (!statusEl) return;

        statusEl.innerText = "Инициализация...";
        document.getElementById('gw_btn_scan').disabled = true;

        let savedLogs = JSON.parse(localStorage.getItem(dbKey)) || [];
        const dStartId = GW_Utils.dateToId(settings.dateTo);
        const dEndId = GW_Utils.dateToId(settings.dateFrom);

        let pageId = 0;
        let scanFinished = false;
        let allNewLogs = [];

        while (pageId < 30 && !scanFinished) {
            statusEl.innerText = `Стр. ${pageId + 1}...`;
            const url = `https://www.gwars.io/transfers.php?user_id=${userId}&page_id=${pageId}`;

            try {
                const response = await fetch(url);
                const buffer = await response.arrayBuffer();
                const html = new TextDecoder('windows-1251').decode(buffer);

                const result = GW_Parser.parseHtmlText(html, dStartId, dEndId);

                if (result.logs.length > 0) {
                    allNewLogs = allNewLogs.concat(result.logs);
                }

                if (result.stopScan || result.logs.length === 0) {
                    scanFinished = true;
                }

                pageId++;
                await new Promise(r => setTimeout(r, 450));
            } catch (e) {
                console.error("Ошибка сканирования:", e);
                statusEl.innerText = "Ошибка!";
                document.getElementById('gw_btn_scan').disabled = false;
                return;
            }
        }

        let merged = [...savedLogs];
        allNewLogs.forEach(newLog => {
            if (!merged.some(m => m.date === newLog.date && m.resource === newLog.resource && m.sum === newLog.sum)) {
                merged.push(newLog);
            }
        });

        merged.sort((a, b) => GW_Utils.parseDate(b.date) - GW_Utils.parseDate(a.date));
        localStorage.setItem(dbKey, JSON.stringify(merged));

        statusEl.innerText = "Готово!";
        document.getElementById('gw_btn_scan').disabled = false;
        setTimeout(() => { statusEl.innerText = ""; }, 2500);
        calculateAndRender();
    }

    // ==========================================
    // 5. ИНТЕРФЕЙС И ОТРЕЗОВКА ТАБЛИЦ
    // ==========================================
    function injectUI() {
        const targetTd = document.querySelector('td.greengreenbg table td[width="40%"][align="right"]') || document.body;

        const wrapper = document.createElement('div');
        wrapper.style.position = 'relative';
        wrapper.style.display = 'inline-block';

        wrapper.innerHTML = `
            <button id="gw_open_calc" style="font-weight:bold; background:#993333; color:white; border:1px solid #333; padding:3px 8px; cursor:pointer; border-radius:3px;">📊 Калькулятор Ресурсов</button>

            <div id="gw_calc_window" style="display:none; position:absolute; right:0; top:25px; width:460px; background:#f4f4f4; border:2px solid #555; padding:12px; font-family:Verdana,sans-serif; font-size:11px; text-align:left; z-index:10000; box-shadow:0 4px 10px rgba(0,0,0,0.3); max-height: 580px; overflow-y: auto; border-radius:4px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px; border-bottom:1px solid #999; padding-bottom:4px;">
                    <b style="font-size:12px; color:#336633;">Аналитика Ресурсов</b>
                    <div>
                        <span id="scan_status" style="color:blue; margin-right:10px; font-weight:bold;"></span>
                        <button id="gw_btn_scan" style="background:green; color:white; border:none; padding:2px 6px; cursor:pointer; font-weight:bold; border-radius:2px;">Обновить данные</button>
                        <button id="gw_close_calc" style="font-weight:bold; cursor:pointer; margin-left:5px;">X</button>
                    </div>
                </div>

                <div style="margin-bottom:8px;">
                    <b>Период (ДД.ММ.ГГ):</b>
                    С <input type="text" id="gw_date_from" value="${settings.dateFrom}" style="width:60px; font-size:11px; text-align:center;">
                    По <input type="text" id="gw_date_to" value="${settings.dateTo}" style="width:60px; font-size:11px; text-align:center;">
                    <button id="gw_btn_apply_dates" style="padding:1px 4px;">ОК</button>
                </div>

                <fieldset style="border:1px solid #999; margin-bottom:8px; padding:6px; border-radius:4px;">
                    <legend><b>Расходы</b></legend>
                    <div style="margin-bottom:4px;">
                        <b>Лицензия:</b>
                        <input type="radio" name="gw_lic" value="0" ${settings.license === '0' ? 'checked' : ''}> Нет
                        <input type="radio" name="gw_lic" value="1" ${settings.license === '1' ? 'checked' : ''}> 1 день
                        <input type="radio" name="gw_lic" value="7" ${settings.license === '7' ? 'checked' : ''}> 7 дней
                        <input type="radio" name="gw_lic" value="30" ${settings.license === '30' ? 'checked' : ''}> 30 дней
                    </div>
                    <div>
                        <input type="checkbox" id="gw_trans_active" ${settings.transportActive ? 'checked' : ''}>
                        <b>Аренда транспорта:</b>
                        <input type="number" id="gw_trans_cost" value="${settings.transportCost}" style="width:70px; font-size:11px;"> Гб
                    </div>
                </fieldset>

                <div id="gw_calc_body"></div>
            </div>
        `;

        targetTd.appendChild(wrapper);

        document.getElementById('gw_open_calc').addEventListener('click', () => {
            const win = document.getElementById('gw_calc_window');
            win.style.display = win.style.display === 'none' ? 'block' : 'none';
        });
        document.getElementById('gw_close_calc').addEventListener('click', () => {
            document.getElementById('gw_calc_window').style.display = 'none';
        });

        document.getElementById('gw_btn_scan').addEventListener('click', startAutoScan);
        document.getElementById('gw_btn_apply_dates').addEventListener('click', saveAndRefresh);

        document.querySelectorAll('input[name="gw_lic"]').forEach(r => r.addEventListener('change', saveAndRefresh));
        document.getElementById('gw_trans_active').addEventListener('change', saveAndRefresh);
        document.getElementById('gw_trans_cost').addEventListener('input', saveAndRefresh);

        calculateAndRender();
    }

    function saveAndRefresh() {
        settings.dateFrom = document.getElementById('gw_date_from').value.trim();
        settings.dateTo = document.getElementById('gw_date_to').value.trim();
        settings.license = document.querySelector('input[name="gw_lic"]:checked').value;
        settings.transportActive = document.getElementById('gw_trans_active').checked;
        settings.transportCost = parseInt(document.getElementById('gw_trans_cost').value, 10) || 0;

        localStorage.setItem(settingsKey, JSON.stringify(settings));
        calculateAndRender();
    }

    function calculateAndRender() {
        const logs = JSON.parse(localStorage.getItem(dbKey)) || [];
        let licenseExpense = GW_Utils.LICENSES[settings.license] || 0;
        let transportExpense = settings.transportActive ? settings.transportCost : 0;
        let totalOverheads = licenseExpense + transportExpense;

        let totalBuy = 0;
        let totalSell = 0;
        let resourcesData = {};

        const minDate = GW_Utils.parseDate(settings.dateFrom + ' 00:00:00');
        const maxDate = GW_Utils.parseDate(settings.dateTo + ' 23:59:59');

        logs.forEach(log => {
            const currentLogDate = GW_Utils.parseDate(log.date);
            if (currentLogDate < minDate || currentLogDate > maxDate) return;

            if (!resourcesData[log.resource]) {
                resourcesData[log.resource] = { buyCount: 0, buySum: 0, sellCount: 0, sellSum: 0 };
            }

            if (log.type === 'продал') {
                totalSell += log.sum;
                resourcesData[log.resource].sellCount += log.count;
                resourcesData[log.resource].sellSum += log.sum;
            } else if (log.type === 'купил') {
                totalBuy += log.sum;
                resourcesData[log.resource].buyCount += log.count;
                resourcesData[log.resource].buySum += log.sum;
            }
        });

        let tradingProfit = totalSell - totalBuy;
        let netProfit = tradingProfit - totalOverheads;

        let resourceRows = '';
        for (let resName in resourcesData) {
            let data = resourcesData[resName];
            let resProfit = data.sellSum - data.buySum;
            let avgBuy = data.buyCount > 0 ? Math.round(data.buySum / data.buyCount) : 0;
            let avgSell = data.sellCount > 0 ? Math.round(data.sellSum / data.sellCount) : 0;

            resourceRows += `
                <tr style="border-bottom:1px solid #ddd;">
                    <td style="padding:5px;"><b>${resName}</b></td>
                    <td style="color:green; text-align:right;">${data.sellCount} ед<br><small style="color:#666">${avgSell} Гб/ед</small></td>
                    <td style="color:#993333; text-align:right;">${data.buyCount} ед<br><small style="color:#666">${avgBuy} Гб/ед</small></td>
                    <td style="font-weight:bold; text-align:right; color:${resProfit >= 0 ? 'green' : 'red'};">${resProfit.toLocaleString('ru-RU')} Гб</td>
                </tr>
            `;
        }

        const bodyEl = document.getElementById('gw_calc_body');
        if (!bodyEl) return;

        bodyEl.innerHTML = `
            <div style="background:#fff; border:1px solid #ccc; padding:8px; margin-top:8px; border-radius:4px;">
                <table style="width:100%; font-size:12px;">
                    <tr><td><b>Оборот (Продажи):</b></td><td style="color:green; text-align:right; font-weight:bold;">+${totalSell.toLocaleString('ru-RU')} Гб</td></tr>
                    <tr><td><b>Закупки:</b></td><td style="color:#993333; text-align:right; font-weight:bold;">-${totalBuy.toLocaleString('ru-RU')} Гб</td></tr>
                    <tr style="border-top:1px solid #ccc;"><td><b>Торговый доход (Маржа):</b></td><td style="text-align:right; font-weight:bold;">${tradingProfit.toLocaleString('ru-RU')} Гб</td></tr>
                    <tr><td><b>Накладные расходы:</b></td><td style="color:#993333; text-align:right;">-${totalOverheads.toLocaleString('ru-RU')} Гб</td></tr>
                    <tr style="border-top:2px double #333; font-size:13px;">
                        <td><b style="color:#336633;">ЧИСТАЯ ПРИБЫЛЬ:</b></td>
                        <td style="text-align:right; font-weight:bold; color:${netProfit >= 0 ? 'green' : 'red'};">${netProfit.toLocaleString('ru-RU')} Гб</td>
                    </tr>
                </table>
            </div>

            <h4 style="margin:10px 0 5px 0; color:#333;">Анализ по ресурсам:</h4>
            <table style="width:100%; border-collapse:collapse; font-size:11px; background:#fff; border:1px solid #ccc;">
                <tr style="background:#e2ebe2; border-bottom:1px solid #999;">
                    <th style="padding:5px; text-align:left;">Наименование</th>
                    <th style="text-align:right; padding-right:5px;">Продажа</th>
                    <th style="text-align:right; padding-right:5px;">Покупка</th>
                    <th style="text-align:right; padding-right:5px;">Профит</th>
                </tr>
                ${resourceRows || '<tr><td colspan="4" style="text-align:center; padding:10px; color:#999;">Нет подходящих ресурсов за указанный период.</td></tr>'}
            </table>
        `;
    }

    injectUI();
})();