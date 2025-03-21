'use strict';

const utils = require('@iobroker/adapter-core');
const os = require('node:os');
const dayjs = require('dayjs');
require('dayjs/locale/de');
const utc = require('dayjs/plugin/utc');
const puppeteer = require('puppeteer');

let interval = null;
let starttimeout = null;
let watchdog = null;
let browser = null;
let page = null;

class DropsWeather extends utils.Adapter {
    /**
     * @param options ioBroker optionen
     */
    constructor(options) {
        super({
            ...options,
            name: 'drops-weather',
        });

        this.baseUrl = 'https://www.meteox.com/en-gb/city/';

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }
    //----------------------------------------------------------------------------------------------------
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        if (!this.config.browserMode) {
            this.config.browserMode = 'automatic';
        }
        this.log.info(`browserMode set to ${this.config.browserMode}`);
        this.chromeExecutable = undefined;

        if (this.config.browserMode === 'built-in') {
            if (os.arch() === 'arm') {
                this.log.error(
                    `browser mode ${this.config.browserMode} not supported at platform ${os.platform()} / ${os.arch()}`,
                );
                this.disable();
                this.terminate();
                return;
            }
        } else if (this.config.browserMode === 'chromium-browser') {
            if (os.platform() !== 'linux' || os.arch() !== 'arm') {
                this.log.error(
                    `browser mode ${this.config.browserMode} not supported at platform ${os.platform()} / ${os.arch()}`,
                );
                this.disable();
                this.terminate();
                return;
            }
            this.chromeExecutable = '/usr/bin/chromium-browser';
        } else if (this.config.browserMode === 'external') {
            this.chromeExecutable = this.config.browserPath;
        } else if (this.config.browserMode === 'automatic') {
            if (os.platform() === 'linux' && os.arch() === 'arm') {
                this.chromeExecutable = '/usr/bin/chromium-browser';
            }
        } else {
            this.log.error(`browser mode ${this.config.browserMode} not (yet) supported`);
            this.disable();
            this.terminate();
            return;
        }

        this.log.info(`browserPath set to ${this.chromeExecutable ? this.chromeExecutable : 'puppeteer default'}`);

        await this.getLanguage();

        watchdog = this.setTimeout(() => {
            this.log.error('timeout connecting to brower ${this.chromeExecutable}');
            this.disable();
            this.terminate();
        }, 10000);

        try {
            browser = await puppeteer.launch({
                headless: true,
                defaultViewport: null,               
                executablePath: this.chromeExecutable,
                args: [
                    '--periodic-task',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu',
                    '--ignore-certificate-errors',
                ],
            });

            this.clearTimeout(watchdog);
            watchdog = null;

        } catch (e) {
            this.log.error(`error launching browser ${this.chromeExecutable} - ${e}`);
            this.disable();
            this.terminate();
            return;
        }

        starttimeout = this.setTimeout(() => {
            if (this.config.citycode === null || this.config.citycode === '') {
                this.log.error(`City code not set - please check instance configuration of ${this.namespace}`);
            } else {
                this.readDataFromServer();
            }
        }, 2000);

        interval = this.setInterval(
            () => {
                if (this.config.citycode === null || this.config.citycode === '') {
                    clearInterval(interval);
                } else {
                    this.readDataFromServer();
                }
            },
            1000 * 60 * 2,
        ); // alle 2 min
    }

    //----------------------------------------------------------------------------------------------------
    async getLanguage() {
        try {
            this.log.debug('getting system language');
            this.getForeignObject('system.config', (err, state) => {
                if (err || state === undefined || state === null) {
                    this.log.warn(`no language set in system configuration of ioBroker set to EN`);
                    dayjs.locale('en');
                } else {
                    this.log.debug(state.common.language);
                    if (state.common.language === 'de') {
                        dayjs.locale('de');
                        this.baseUrl = this.baseUrl;
                    } else {
                        dayjs.locale('en');
                    }
                }
            });
        } catch (error) {
            this.log.warn(error);
        }
    }
    //----------------------------------------------------------------------------------------------------
    async readDataFromServer() {
        const url = this.baseUrl + this.config.citycode;

        this.log.debug(`Reading data from : ${url}`);

        let weatherdataFound = false;

        this.log.debug(`creating new page ...`);

        page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        );
        
        try {            
            await page.goto(url, {
                waitUntil: 'networkidle2', // Warten, bis die Seite fertig geladen ist
            });

            await page.waitForFunction(() => {
                return [...document.querySelectorAll('script')].some(script => script.textContent.includes('RainGraph.create({'));
            }, { timeout: 15000 });
            
            this.log.debug(`domcontent loaded, evaluate page`);
            const scriptContents = await page.evaluate(() => {
                // @ts-expect-error document seems to be defined by puppeteer
                // eslint-disable-next-line no-undef
                const scripts = document.querySelectorAll('script'); // ja das ist korrekt so
                for (let script of scripts) {
                    if (script.textContent.includes('RainGraph.create({')) {
                        return script.textContent.split('\n');
                    }
                }
                return null;
            });
            this.log.debug(`got scriptContents "${JSON.stringify(scriptContents)}"`);

            const labeltext = await page.evaluate(() => {
                // @ts-expect-error document seems to be defined by puppeteer
                // eslint-disable-next-line no-undef
                const element = document.querySelector('p[data-component="rainGraph-nowcastText"]');
                const labeltext = element ? element.textContent : 'Kein Text gefunden';
                return labeltext;
            });

            this.log.debug(`got labeltext "${labeltext}"`);
            this.setStateAsync('data_1h.labeltext', { val: labeltext, ack: true });

            for (const scriptContent of scriptContents) {
                if (scriptContent.includes('series')) {
                    this.log.debug('weatherData found');
                    let data = scriptContent.substring(scriptContent.indexOf('series'));

                    if (data.includes('}}},')) {
                        weatherdataFound = true;
                        data = data.substring(7, data.indexOf('}}},') + 3);
                        data = data.replace('2h', 'data2h');
                        data = data.replace('24h', 'data24h');

                        const dataJSON = JSON.parse(data);
                        this.log.debug('creating 5 min states');
                        this.createStateData(dataJSON.data2h.data, 'data_5min');

                        this.log.debug('creating 1 hour states');
                        this.createStateData(dataJSON.data24h.data, 'data_1h');
                    } else {
                        this.log.debug('end of data in series NOT found');
                    }
                }
            }

            await page.close();
            
            if (!weatherdataFound) {
                this.log.warn('no weatherData found in HTML');
            }
        } catch (error) {
            this.log.warn(error);
        }
    }

    splitByNewline(inputString) {
        return inputString.split('\n');
    }

    //----------------------------------------------------------------------------------------------------
    async createStateData(data, channel) {
        try {
            let JSONdata_rain = [];
            let JSONdata_echart = [];
            let raindata = [];
            let isRainingNow = false;
            let rainStartsAt = '-1';
            let rainStartAmount = 0;
            let dateformat = 'HH:mm';

            if (channel == 'data_1h') {
                dateformat = 'dd HH:mm';
            }
            //	this.log.info(JSON.stringify(data));

            if (data[0].precipitationrate > 0) {
                isRainingNow = true;
            }

            this.setStateAsync(`${channel}.isRainingNow`, { val: isRainingNow, ack: true });

            await this.setStateAsync(`${channel}.timestamp`, { val: data[0].time, ack: true });
            await this.setStateAsync(`${channel}.actualRain`, { val: data[0].precipitationrate, ack: true });

            for (const i in data) {
                raindata.push(data[i].precipitationrate);

                const item_rain = {};
                const item_rain_echart = {};

                //const dat = data[i].time;
                const date = dayjs(data[i].time);

                dayjs.extend(utc);
                const timestamp = dayjs.utc(data[i].time).valueOf();

                if (rainStartsAt == '-1') {
                    if (data[i].precipitationrate > 0) {
                        rainStartsAt = date.format('YYYY-MM-DDTHH:mm:ssZ');
                        rainStartAmount = 0;
                        if (data[i].c != undefined) {
                            rainStartAmount = data[i].c;
                        }
                    }
                }
                //this.log.debug(date.format('HH:mm').toString());

                item_rain['label'] = date.format(dateformat).toString();
                item_rain['value'] = data[i].precipitationrate.toString();
                JSONdata_rain.push(item_rain);

                item_rain_echart['ts'] = timestamp;
                item_rain_echart['val'] = data[i].precipitationrate;
                JSONdata_echart.push(item_rain_echart);
            }
            JSONdata_rain = JSON.parse(JSON.stringify(JSONdata_rain));
            JSONdata_echart = JSON.parse(JSON.stringify(JSONdata_echart));

            raindata = JSON.parse(JSON.stringify(raindata));

            this.log.debug(`Rain (${channel}): ${JSON.stringify(JSONdata_rain)}`);

            await this.setStateAsync(`${channel}.chartRain`, { val: JSON.stringify(JSONdata_rain), ack: true });
            await this.setStateAsync(`${channel}.echartRain`, { val: JSON.stringify(JSONdata_echart), ack: true });
            await this.setStateAsync(`${channel}.raindata`, { val: JSON.stringify(raindata), ack: true });
            await this.setStateAsync(`${channel}.rainStartsAt`, { val: rainStartsAt, ack: true });
            await this.setStateAsync(`${channel}.startRain`, { val: rainStartAmount, ack: true });
        } catch (error) {
            this.log.error(error);
        }
    }

    async destroyBrowser() {
        this.log.debug('destroy browser');
        const pages = await browser.pages();
        for (let i = 0; i < pages.length; i++) {
            await pages[i].close();
        }
        await browser.close();
    }

    //----------------------------------------------------------------------------------------------------
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback iobroker callback
     */
    onUnload(callback) {
        try {
            this.destroyBrowser();
            this.clearInterval(interval);
            this.clearTimeout(starttimeout);
            this.clearTimeout(watchdog);
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = options => new DropsWeather(options);
} else {
    // otherwise start the instance directly
    // @ts-expect-error no options is ok
    new DropsWeather();
}
