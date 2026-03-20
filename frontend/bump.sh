#!/bin/bash
NEW=$1
DIR=/srv/www/laowudiy/music-ui

if [ -z "$NEW" ]; then
  CUR=$(grep -oP "APP_VERSION = '\K[^']+" $DIR/app.js)
  echo "Current version: $CUR"
  echo "Usage: ./bump.sh b135"
  exit 1
fi

CUR=$(grep -oP "APP_VERSION = '\K[^']+" $DIR/app.js)
echo "Bumping $CUR -> $NEW"

# Backup current files (keep last 3 per file)
for f in app.js sw.js index.html login.html admin.html pwa.css styles.css; do
  [ -f "$DIR/$f" ] && cp "$DIR/$f" "$DIR/$f.bak-$CUR"
  ls -t $DIR/$f.bak-* 2>/dev/null | tail -n +4 | xargs rm -f 2>/dev/null
done

# 1. app.js — APP_VERSION
sed -i "s/APP_VERSION = '$CUR'/APP_VERSION = '$NEW'/" $DIR/app.js

# 2. sw.js — cache name
SWCACHE=$(grep -oP "l5music-b[0-9]+" $DIR/sw.js | head -1)
sed -i "s/$SWCACHE/l5music-$NEW/g" $DIR/sw.js

# 3. sw.js — build comment (sw.js bNN -> bNN+1)
SWNUM=$(grep -oP 'sw\.js b\K\d+' $DIR/sw.js)
if [ -n "$SWNUM" ]; then
  SWNUM_NEW=$((SWNUM + 1))
  sed -i "s/sw\.js b$SWNUM/sw.js b$SWNUM_NEW/" $DIR/sw.js
fi

# 4. Asset version strings in sw.js + index.html
sed -i "s/app\.js?v=$CUR/app.js?v=$NEW/g" $DIR/sw.js $DIR/index.html
sed -i "s/pwa\.css?v=[^\"']*/pwa.css?v=$NEW/g" $DIR/sw.js $DIR/index.html
sed -i "s/styles\.css?v=b[0-9]*/styles.css?v=$NEW/g" $DIR/index.html

# 5. Favicon version in all HTML files
for html in index.html login.html admin.html; do
  [ -f "$DIR/$html" ] && sed -i "s/favicon\.png?v=[^\"']*/favicon.png?v=$NEW/g" "$DIR/$html"
done
# 6. Login page asset versions
[ -f "$DIR/login.html" ] && sed -i "s/styles\.css?v=b[0-9]*/styles.css?v=$NEW/g" "$DIR/login.html"
[ -f "$DIR/login.html" ] && sed -i "s/login\.js?v=b[0-9]*/login.js?v=$NEW/g" "$DIR/login.html"

# Restart
docker restart laowudiy-home

# Verify
echo ""
echo "=== Verify ==="
grep "APP_VERSION" $DIR/app.js
grep "CACHE" $DIR/sw.js | head -1
grep "sw.js b" $DIR/sw.js | head -1
grep 'favicon.*v=' $DIR/index.html | head -1
echo ""
echo "Done: $NEW is live"
