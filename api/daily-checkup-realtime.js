// Vercel Serverless Function - Daily Check-up Real-time API
// Fetches real-time data directly from Walmart Marketplace API via n8n workflow

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const BASE_ID = 'appRCQASsApV4C33N';
    const TABLE_ID = 'tblo1uuy8Nc9CSjX4';
    const N8N_WEBHOOK_URL = 'https://n8n.nuxec.com/webhook/daily-checkup-realtime';

    if (!AIRTABLE_API_KEY) {
        return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
    }

    const { limit = '10', store } = req.query;

    try {
        // Step 1: Fetch top products from Airtable (just basic info + SKU)
        let filterFormula = "AND({7-Day Sales}>0, OR({Store}='WM19', {Store}='WM24'))";
        if (store && store !== 'all') {
            filterFormula = `AND({7-Day Sales}>0, {Store}='${store}')`;
        }

        const fields = [
            'SKU',
            'Product ID',
            'Store',
            '7-Day Sales',
            '3-Day Sales',
            'Title',
            'Walmart Listing URL',
            // Cost and margin fields from Airtable
            'Product Cost',
            'Approved Base Price',
            'Declared Price',
            'Primary Supplier Link',
            // Publish status from Airtable (synced by other workflows)
            'WM Publish Status',
            'WM Inventory',
            // Scrape data for sellers and pricing
            'Scrape Seller Name',
            'Scrape Price',
            'Scrape Current Price',
            'Scrape Total Sellers',
            'Scrape 3P Seller Count',
            'Scrape Price 3P',
            'Scrape Availability Status',
            'Scrape Out of Stock',
            'Scrape Rating',
            'Scrape Review Count',
            'Scrape Brand',
            'Scrape Low Stock Message',
            // Daily Check seller data
            'Daily Check All Sellers',
            'Daily Check Our Rank',
            'Daily Check Our Price',
            'Daily Check Lowest 3P Price',
            'Daily Check Is Winning',
        ];

        const airtableUrl = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`);
        airtableUrl.searchParams.set('filterByFormula', filterFormula);
        airtableUrl.searchParams.set('sort[0][field]', '7-Day Sales');
        airtableUrl.searchParams.set('sort[0][direction]', 'desc');
        airtableUrl.searchParams.set('maxRecords', limit);
        fields.forEach(field => airtableUrl.searchParams.append('fields[]', field));

        const airtableResponse = await fetch(airtableUrl.toString(), {
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json',
            }
        });

        if (!airtableResponse.ok) {
            const errorData = await airtableResponse.json();
            return res.status(airtableResponse.status).json({
                error: errorData.error?.message || 'Failed to fetch from Airtable'
            });
        }

        const airtableData = await airtableResponse.json();
        const records = airtableData.records || [];

        // Step 2: Prepare products for n8n webhook
        const productsForN8n = records.map(record => ({
            sku: record.fields.SKU,
            store: record.fields.Store || 'WM19',
            productId: record.fields['Product ID'],
        }));

        // Step 3: Call n8n webhook for real-time Walmart data
        let realTimeData = null;
        try {
            const n8nResponse = await fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ products: productsForN8n }),
            });

            if (n8nResponse.ok) {
                realTimeData = await n8nResponse.json();
            } else {
                console.error('n8n webhook error:', await n8nResponse.text());
            }
        } catch (n8nError) {
            console.error('n8n webhook call failed:', n8nError.message);
        }

        // Step 4: Merge Airtable data with real-time data
        const realTimeMap = {};
        if (realTimeData?.products) {
            for (const p of realTimeData.products) {
                realTimeMap[p.sku] = p.realTime;
            }
        }

        const products = records.map((record) => {
            const f = record.fields;
            const sku = f.SKU || '';
            const realTime = realTimeMap[sku] || {};

            // Pricing data from Airtable
            const productCost = f['Product Cost'] || null;
            const ourSellingPrice = f['Approved Base Price'] || null;
            const declaredPrice = f['Declared Price'] || null;

            // Real-time inventory from Walmart API
            const defaultInventory = realTime.defaultInventory || 0;
            const fcInventory = realTime.fcInventory || 0;
            const totalInventory = realTime.totalInventory || Math.max(defaultInventory, fcInventory);

            // Publish status - prefer Airtable (already synced) if real-time is Unknown
            let publishedStatus = realTime.publishedStatus;
            if (!publishedStatus || publishedStatus === 'Unknown') {
                const wmStatus = f['WM Publish Status'] || '';
                if (wmStatus.includes('PUBLISHED') || wmStatus.includes('ACTIVE')) {
                    publishedStatus = 'PUBLISHED';
                } else if (wmStatus.includes('UNPUBLISHED') || wmStatus.includes('RETIRED')) {
                    publishedStatus = 'UNPUBLISHED';
                } else {
                    publishedStatus = wmStatus || 'Unknown';
                }
            }

            // Walmart.com current price - from scrape data or real-time
            const walmartPrice = realTime.walmartPrice || f['Scrape Current Price'] || f['Scrape Price'] || null;

            // Calculate Margin using correct formula:
            // Margin = Our Selling Price - Product Cost - $4.5 shipping - (Our Selling Price * 10.5% platform fee)
            let marginDollar = null;
            let marginPercent = null;
            if (ourSellingPrice && productCost) {
                const platformFee = ourSellingPrice * 0.105;
                const shippingCost = 4.5;
                marginDollar = ourSellingPrice - productCost - shippingCost - platformFee;
                marginPercent = marginDollar / ourSellingPrice;
            }

            // Inventory warning
            const inventoryWarning = totalInventory === 0;

            // Parse seller data from Airtable
            let sellers = [];
            try {
                if (f['Daily Check All Sellers']) {
                    sellers = JSON.parse(f['Daily Check All Sellers']);
                }
            } catch {
                sellers = [];
            }

            // Seller and competition data
            const totalSellers = f['Scrape Total Sellers'] || sellers.length || 1;
            const thirdPartySellers = f['Scrape 3P Seller Count'] || 0;
            const lowest3PPrice = f['Daily Check Lowest 3P Price'] || f['Scrape Price 3P'] || null;
            const ourRank = f['Daily Check Our Rank'] || null;
            const isWinning = f['Daily Check Is Winning'] || (ourSellingPrice && lowest3PPrice ? ourSellingPrice <= lowest3PPrice : false);

            return {
                id: record.id,
                sku,
                productId: f['Product ID'] || '',
                title: f.Title || f.SKU || 'Unknown Product',
                store: f.Store || 'Unknown',
                sales7Day: f['7-Day Sales'] || 0,
                sales3Day: f['3-Day Sales'] || 0,
                // Pricing from Airtable
                productCost,
                ourSellingPrice,
                declaredPrice,
                walmartPrice,
                // Real-time inventory from Walmart API
                defaultInventory,
                fcInventory,
                totalInventory,
                inventoryWarning,
                // Publish status (combined)
                publishedStatus,
                // Calculated margin
                marginDollar,
                marginPercent,
                // Competition data
                sellers,
                totalSellers,
                thirdPartySellers,
                lowest3PPrice,
                ourRank,
                isWinning,
                buyBoxSeller: f['Scrape Seller Name'] || 'Unknown',
                // Product info
                productName: realTime.productName || f.Title,
                brand: f['Scrape Brand'] || null,
                rating: f['Scrape Rating'] || null,
                reviewCount: f['Scrape Review Count'] || 0,
                availability: f['Scrape Availability Status'] || 'Unknown',
                lowStockWarning: f['Scrape Low Stock Message'] || null,
                // Links
                supplierLink: f['Primary Supplier Link'] || null,
                walmartUrl: f['Walmart Listing URL'] || `https://www.walmart.com/ip/${f['Product ID']}`,
                // Timestamp
                lastChecked: realTimeData?.timestamp || new Date().toISOString(),
                isRealTime: totalInventory > 0 || (realTime.defaultInventory !== undefined),
            };
        });

        // Calculate summary stats
        const published = products.filter(p => p.publishedStatus === 'PUBLISHED').length;
        const unpublished = products.filter(p => p.publishedStatus === 'UNPUBLISHED').length;
        const zeroInventory = products.filter(p => p.inventoryWarning).length;

        const summary = {
            totalProducts: products.length,
            published,
            unpublished,
            unknown: products.length - published - unpublished,
            zeroInventory,
            totalSales7Day: products.reduce((sum, p) => sum + (p.sales7Day || 0), 0),
            totalSales3Day: products.reduce((sum, p) => sum + (p.sales3Day || 0), 0),
            lastCheck: realTimeData?.timestamp || new Date().toISOString(),
            isRealTime: !!realTimeData,
        };

        return res.status(200).json({
            success: true,
            summary,
            products,
        });

    } catch (error) {
        console.error('Daily check-up real-time API error:', error);
        return res.status(500).json({ error: error.message });
    }
}
