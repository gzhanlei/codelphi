ALTER TABLE products ADD COLUMN source_roots JSON NULL AFTER description;

UPDATE products SET source_roots = CASE slug
  WHEN 'radar' THEN JSON_ARRAY('')
  WHEN 'chandler' THEN JSON_ARRAY('internal', 'web')
  WHEN 'android-airplay-receiver' THEN JSON_ARRAY('app/src/main', 'uxplay/lib')
  ELSE source_roots
END
WHERE slug IN ('radar', 'chandler', 'android-airplay-receiver');
