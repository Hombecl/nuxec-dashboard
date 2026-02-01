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

    // Build filter formula - only WM19/WM24 products with sales
    // Note: Status is null for many records, so we just filter by store and sales
    let filterFormula = "AND({7-Day Sales}>0, OR({Store}='WM19', {Store}='WM24'))";
    if (store && store !== 'all') {
        filterFormula = `AND({7-Day Sales}>0, {Store}='${store}')`;
    }

    // Build URL with fields - includes both Daily Check and Scrape fields
    const fields = [
        'SKU',
        'Product ID',
        'Store',
        '7-Day Sales',
        '3-Day Sales',
        'Title',
        'Walmart Listing URL',
        'WM Publish Status',
        'WM Inventory',
        // Daily Check fields
        'Daily Check Our Rank',
        'Daily Check Our Price',
        'Daily Check Our Shipping',
        'Daily Check All Sellers',
        'Daily Check Is Winning',
        'Daily Check Last Run',
        'Daily Check Lowest 3P Price',
        'Daily Check Price Diff',
        'Daily Check Publish Status',
        // Scrape fields (already populated by other workflows)
        'Scrape Seller Name',
        'Scrape Price',
        'Scrape Shipping',
        'Scrape Total Sellers',
        'Scrape 3P Seller Count',
        'Scrape Price 3P',
        'Scrape Availability Status',
        'Scrape Delivery',
        'Scrape Last Date',
        'Scrape Rating',
        'Scrape Review Count',
        'Scrape Brand',
        'Scrape Low Stock Message',
        'Scrape Out of Stock',
        'Scrape Current Price',
        'Scrape Shipping Fee',
        'Scrape Total Price',
        // Cost and margin
        'Product Cost',
        'Approved Base Price',
        'Margin%',
        'Declared Price',
        // Additional pricing fields
        'Primary Supplier Link',
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

            // Pricing data
            const productCost = f['Product Cost'] || null; // Cost to buy from store
            const walmartComPrice = f['Scrape Current Price'] || f['Scrape Price'] || null; // Walmart.com current price
            const ourSellingPrice = f['Approved Base Price'] || null; // Our selling price on Walmart
            const declaredPrice = f['Declared Price'] || null; // Declared shipping value

            const totalSellers = f['Scrape Total Sellers'] || sellers.length || 1;
            const thirdPartySellers = f['Scrape 3P Seller Count'] || 0;
            const lowest3P = f['Daily Check Lowest 3P Price'] || f['Scrape Price 3P'] || null;

            // Calculate Margin using correct formula:
            // Margin = Our Selling Price - Product Cost - $4.5 shipping - (Our Selling Price * 10.5% platform fee)
            let marginDollar = null;
            let marginPercent = null;
            if (ourSellingPrice && productCost) {
                const platformFee = ourSellingPrice * 0.105; // 10.5% platform fee
                const shippingCost = 4.5; // Fixed shipping cost
                marginDollar = ourSellingPrice - productCost - shippingCost - platformFee;
                marginPercent = marginDollar / ourSellingPrice;
            }

            // Determine publish/availability status
            let publishStatus = f['Daily Check Publish Status'] || 'Unknown';
            if (publishStatus === 'Unknown' && f['WM Publish Status']) {
                publishStatus = f['WM Publish Status'].includes('ACTIVE') ? 'Published' : f['WM Publish Status'];
            }
            if (f['Scrape Out of Stock']) {
                publishStatus = 'Out of Stock';
            } else if (f['Scrape Availability Status'] === 'OUT_OF_STOCK') {
                publishStatus = 'Out of Stock';
            }

            // Inventory check - flag if 0
            const inventory = f['WM Inventory'] || 0;
            const inventoryWarning = inventory === 0;

            // Determine if we're competitive (winning)
            let isWinning = f['Daily Check Is Winning'] || false;
            if (!isWinning && ourSellingPrice && lowest3P) {
                isWinning = ourSellingPrice <= lowest3P;
            }

            return {
                id: record.id,
                sku: f.SKU || '',
                productId: f['Product ID'] || '',
                title: f.Title || f.SKU || 'Unknown Product',
                store: f.Store || 'Unknown',
                sales7Day: f['7-Day Sales'] || 0,
                sales3Day: f['3-Day Sales'] || 0,
                // Pricing - clear naming for comparison
                productCost, // What we pay at Walmart store
                walmartComPrice, // Walmart.com's current price
                ourSellingPrice, // Our listing price
                declaredPrice, // Declared shipping value
                // Margin with correct calculation
                marginDollar,
                marginPercent,
                // Competition
                ourRank: f['Daily Check Our Rank'] || null,
                isWinning,
                lowest3PPrice: lowest3P,
                priceDiff: ourSellingPrice && lowest3P ? ourSellingPrice - lowest3P : null,
                totalSellers,
                thirdPartySellers,
                // Buy box winner info
                buyBoxSeller: f['Scrape Seller Name'] || 'Unknown',
                buyBoxPrice: walmartComPrice,
                // Status
                publishStatus,
                inventory,
                inventoryWarning,
                availability: f['Scrape Availability Status'] || 'Unknown',
                lowStockWarning: f['Scrape Low Stock Message'] || null,
                // Product info
                rating: f['Scrape Rating'] || null,
                reviewCount: f['Scrape Review Count'] || 0,
                brand: f['Scrape Brand'] || null,
                hasDelivery: f['Scrape Delivery'] || false,
                // Links
                supplierLink: f['Primary Supplier Link'] || null,
                // Timestamps
                lastCheck: f['Daily Check Last Run'] || f['Scrape Last Date'] || null,
                sellers,
                walmartUrl: f['Walmart Listing URL'] || `https://www.walmart.com/ip/${f['Product ID']}`,
            };
        });

        // Calculate summary stats
        const published = products.filter(p => p.publishStatus === 'Published' || p.publishStatus?.includes('ACTIVE'));
        const outOfStock = products.filter(p => p.publishStatus === 'Out of Stock' || p.availability === 'OUT_OF_STOCK');
        const withCompetitors = products.filter(p => p.thirdPartySellers > 0);
        const winning = products.filter(p => p.isWinning);
        const zeroInventory = products.filter(p => p.inventoryWarning);

        const summary = {
            totalProducts: products.length,
            published: published.length,
            outOfStock: outOfStock.length,
            zeroInventory: zeroInventory.length,
            withCompetitors: withCompetitors.length,
            winning: winning.length,
            losing: products.filter(p => !p.isWinning && p.lowest3PPrice !== null).length,
            noCompetitorData: products.filter(p => p.thirdPartySellers === 0 && !p.lowest3PPrice).length,
            totalSales7Day: products.reduce((sum, p) => sum + (p.sales7Day || 0), 0),
            totalSales3Day: products.reduce((sum, p) => sum + (p.sales3Day || 0), 0),
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
