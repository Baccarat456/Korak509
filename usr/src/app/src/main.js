// Apify SDK - toolkit for building Apify Actors
import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// Initialize Actor environment
await Actor.init();

// Read input (defined in .actor/input_schema.json)
const { startUrls = ['https://apify.com'], maxRequestsPerCrawl = 200 } = (await Actor.getInput()) ?? {};

// Use Apify proxy (recommended for production)
const proxyConfiguration = await Actor.createProxyConfiguration();

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ enqueueLinks, request, $, log }) {
        const url = request.loadedUrl ?? request.url;
        log.info('Processing', { url });

        // Enqueue likely menu and restaurant pages found on directory/search pages
        await enqueueLinks({
            globs: ['**/menu**', '**/menus**', '**/restaurant/**', '**/restaurants/**', '**/food/**'],
        });

        // Heuristic: detect pages likely containing menus
        const pageText = $('body').text().toLowerCase();
        const looksLikeMenu = url.toLowerCase().includes('menu') || pageText.includes('menu') || pageText.includes('price') || pageText.includes('$');

        if (!looksLikeMenu) {
            log.debug('Page does not look like a menu; skipping', { url });
            return;
        }

        try {
            // Restaurant name heuristics
            const restaurantName =
                $('meta[property="og:site_name"]').attr('content') ||
                $('meta[property="og:title"]').attr('content') ||
                $('h1').first().text().trim() ||
                $('title').first().text().trim();

            // Candidate menu containers: look for classes/ids with 'menu', 'dish', 'item', or list elements with price patterns
            const menuContainers = $('[class*="menu"], [id*="menu"], [class*="dish"], [class*="item"], .menu, .menu-section, section')
                .filter((i, el) => {
                    const t = $(el).text().toLowerCase();
                    return t.includes('$') || t.match(/\d+\s?(\$|€|£)/) || t.includes('price') || t.includes('ingredients') || t.includes('cal');
                });

            // Fallback: search for any element containing currency pattern
            const fallbackContainers = $('*').filter((i, el) => {
                const t = $(el).text();
                return /\$[\s\d,.]+|£[\s\d,.]+|€[\s\d,.]+|\d+\s?USD|\d+\s?EUR/.test(t);
            });

            const containers = menuContainers.length ? menuContainers : fallbackContainers.slice(0, 200);

            // Extract items by scanning containers for lines that look like "name ... price"
            const seen = new Set();
            for (let i = 0; i < containers.length; i++) {
                const el = containers[i];
                const $el = $(el);

                // Look for list items first
                $el.find('li, .menu-item, .dish, .item').each(async (j, li) => {
                    const text = $(li).text().trim().replace(/\s+/g, ' ');
                    if (!text) return;

                    // Try to split by price (common patterns)
                    const priceMatch = text.match(/((?:\$|£|€)\s?\d+[,\d]*(?:\.\d+)?|\d+[,\d]*(?:\.\d+)?\s?(?:USD|EUR|GBP))/);
                    if (!priceMatch) return;

                    const priceText = priceMatch[0].trim();
                    const currencyMatch = priceText.match(/(\$|€|£|USD|EUR|GBP)/i);
                    const currency = currencyMatch ? currencyMatch[0] : '';

                    // Remove price from text
                    const nameDesc = text.replace(priceMatch[0], '').trim();
                    // Heuristics: split name and description by dash or '—' or '–' or ' - '
                    let [itemName, itemDesc] = nameDesc.split(/\s[-–—:]\s/);
                    if (!itemDesc) {
                        // fallback: first sentence as name
                        const parts = nameDesc.split('.');
                        itemName = parts.shift();
                        itemDesc = parts.join('.').trim();
                    }
                    itemName = (itemName || '').trim();
                    itemDesc = (itemDesc || '').trim();

                    const key = `${restaurantName}|${itemName}|${priceText}`;
                    if (seen.has(key)) return;
                    seen.add(key);

                    await Dataset.pushData({
                        restaurant_name: restaurantName || '',
                        item_name: itemName || nameDesc || '',
                        category: $el.closest('section, .menu-section, .category').find('h2, h3').first().text().trim() || '',
                        price: priceText,
                        currency,
                        description: itemDesc || '',
                        url,
                    });
                });

                // If no list items matched, try line-based parsing inside the container
                if (seen.size === 0) {
                    const lines = $el.text().split('\n').map((l) => l.trim()).filter(Boolean);
                    for (const line of lines) {
                        const priceMatch = line.match(/((?:\$|£|€)\s?\d+[,\d]*(?:\.\d+)?|\d+[,\d]*(?:\.\d+)?\s?(?:USD|EUR|GBP))/);
                        if (!priceMatch) continue;
                        const priceText = priceMatch[0].trim();
                        const currencyMatch = priceText.match(/(\$|€|£|USD|EUR|GBP)/i);
                        const currency = currencyMatch ? currencyMatch[0] : '';
                        const nameDesc = line.replace(priceMatch[0], '').trim();
                        let [itemName, itemDesc] = nameDesc.split(/\s[-–—:]\s/);
                        if (!itemDesc) {
                            const parts = nameDesc.split('.');
                            itemName = parts.shift();
                            itemDesc = parts.join('.').trim();
                        }
                        const key = `${restaurantName}|${itemName}|${priceText}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        await Dataset.pushData({
                            restaurant_name: restaurantName || '',
                            item_name: itemName || nameDesc || '',
                            category: '',
                            price: priceText,
                            currency,
                            description: itemDesc || '',
                            url,
                        });
                    }
                }
            }

            // If nothing was found, attempt to capture top-level price blocks
            if (seen.size === 0) {
                const altPrice = $('*[class*="price"], .price, .cost, .amount').first().text().trim();
                if (altPrice) {
                    await Dataset.pushData({
                        restaurant_name: restaurantName || '',
                        item_name: 'price_block',
                        category: '',
                        price: altPrice,
                        currency: (altPrice.match(/(\$|€|£|USD|EUR|GBP)/i) || [''])[0] || '',
                        description: '',
                        url,
                    });
                    log.info('Saved fallback price block', { url, altPrice });
                } else {
                    log.debug('No menu items or price blocks extracted', { url });
                }
            }
        } catch (err) {
            log.warning('Extraction failed', { url, message: err.message });
        }
    },
});

await crawler.run(startUrls);

// Gracefully exit
await Actor.exit();
