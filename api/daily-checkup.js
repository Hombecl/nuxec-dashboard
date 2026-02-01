// Vercel Serverless Function - Daily Check-up API
// Fetches top 10 products with Daily Check data from Airtable

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const BASE_ID = 'appRCQASsApV4C33N';
    const TABLE_ID = 'tblo1uuy8Nc9CSjX4';

    if (!AIRTABLE_API_KEY) {
        return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
    }

    const { limit = '10', store } = req.query;

    // Build filter formula - only WM19/WM24 Active products with sales
    let filterFormula = "AND({Status}='Active', {7-Day Sales}>0, OR({Store}='WM19', {Store}='WM24'))";
    if (store && store !== 'all') {
        filterFormula = `AND({Status}='Active', {7-Day Sales}>0, {Store}='${store}')`;
    }

    // Build URL with fields
    const fields = [
        'SKU',
        'Product ID',
        'Store',
        '7-Day Sales',
        'Daily Check Our Rank',
        'Daily Check Our Price',
        'Daily Check Our Shipping',
        'Daily Check All Sellers',
        'Daily Check Is Winning',
        'Daily Check Last Run',
        'Daily Check Lowest 3P Price',
        'Daily Check Price Diff',
        'Scrape Total Sellers',
        'Title',
        'Walmart Listing URL'
    ];

    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`);
    url.searchParams.set('filterByFormula', filterFormula);
    url.searchParams.set('sort[0][field]', '7-Day Sales');
    url.searchParams.set('sort[0][direction]', 'desc');
    url.searchParams.set('maxRecords', limit);
    fields.forEach(field => url.searchParams.append('fields[]', field));

    try {
        const response = await fetch(url.toString(), {
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json',
            }
        });

        if (!response.ok) {
            const errorData = await response.json();
            return res.status(response.status).json({
                error: errorData.error?.message || 'Failed to fetch from Airtable'
            });
        }

        const data = await response.json();
        const records = data.records || [];

        // Transform records
        const products = records.map((record) => {
            const f = record.fields;
            let sellers = [];

            try {
                if (f['Daily Check All Sellers']) {
                    sellers = JSON.parse(f['Daily Check All Sellers']);
                }
            } catch {
                sellers = [];
            }

            const ourPrice = f['Daily Check Our Price'] || null;
            const ourShipping = f['Daily Check Our Shipping'] || 0;
            const ourTotal = ourPrice ? ourPrice + ourShipping : null;

            return {
                id: record.id,
                sku: f.SKU || '',
                productId: f['Product ID'] || '',
                title: f.Title || f.SKU || 'Unknown Product',
                store: f.Store || 'Unknown',
                sales7Day: f['7-Day Sales'] || 0,
                ourRank: f['Daily Check Our Rank'] || null,
                ourPrice: f['Daily Check Our Price'] || null,
                ourShipping: f['Daily Check Our Shipping'] || null,
                ourTotal,
                isWinning: f['Daily Check Is Winning'] || false,
                lowest3PPrice: f['Daily Check Lowest 3P Price'] || null,
                priceDiff: f['Daily Check Price Diff'] || null,
                totalSellers: f['Scrape Total Sellers'] || sellers.length,
                lastCheck: f['Daily Check Last Run'] || null,
                sellers,
                walmartUrl: f['Walmart Listing URL'] || `https://www.walmart.com/ip/${f['Product ID']}`,
            };
        });

        // Calculate summary stats
        const summary = {
            totalProducts: products.length,
            winning: products.filter(p => p.isWinning).length,
            losing: products.filter(p => !p.isWinning && p.ourRank !== null).length,
            notFound: products.filter(p => p.ourRank === null).length,
            lastCheck: products[0]?.lastCheck || null,
        };

        return res.status(200).json({
            success: true,
            summary,
            products,
        });

    } catch (error) {
        console.error('Daily check-up API error:', error);
        return res.status(500).json({ error: error.message });
    }
}
