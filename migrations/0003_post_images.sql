-- Keep the original image_url for existing records and add an ordered gallery for new posts.
ALTER TABLE events ADD COLUMN image_urls TEXT;
