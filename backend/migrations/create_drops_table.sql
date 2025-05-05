-- Create drops table
CREATE TABLE IF NOT EXISTS drops (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop TEXT NOT NULL,
  product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail_url TEXT,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE,
  duration_minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_drops_shop ON drops(shop);
CREATE INDEX IF NOT EXISTS idx_drops_status ON drops(status);
CREATE INDEX IF NOT EXISTS idx_drops_start_time ON drops(start_time);

-- Create trigger to automatically set end_time based on start_time and duration_minutes
CREATE OR REPLACE FUNCTION calculate_end_time()
RETURNS TRIGGER AS $$
BEGIN
  NEW.end_time := NEW.start_time + (NEW.duration_minutes * INTERVAL '1 minute');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_end_time ON drops;
CREATE TRIGGER set_end_time
BEFORE INSERT OR UPDATE OF start_time, duration_minutes ON drops
FOR EACH ROW
EXECUTE FUNCTION calculate_end_time();

-- Create trigger to automatically update updated_at
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_drops_timestamp ON drops;
CREATE TRIGGER update_drops_timestamp
BEFORE UPDATE ON drops
FOR EACH ROW
EXECUTE FUNCTION update_timestamp(); 