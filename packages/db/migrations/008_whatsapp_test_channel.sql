-- Orders placed through the TESTING-ONLY WhatsApp Web bridge (apps/wa-test, unofficial Baileys
-- library) are labelled 'whatsapp_test', so they are never mistaken for Cloud API orders.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_channel_check;
ALTER TABLE orders ADD CONSTRAINT orders_channel_check CHECK (channel IN ('whatsapp', 'whatsapp_test', 'terminal'));
