"""生成一张带真实 GPS EXIF 的示例照片（用于演示照片定位功能）。

用法：python tools/make_sample_photo.py
改地点：修改下面的 PLACE / LAT / LON 三个常量即可。

只依赖 Pillow。EXIF 里写入 GPS 经纬度和拍摄信息，
浏览器端用 exifr 解析后即可在三维地球上定位。
"""
from pathlib import Path

from PIL import Image, ImageDraw
from PIL.TiffImagePlugin import IFDRational

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "sample-with-gps.jpg"

PLACE = "West Lake, Hangzhou"
LAT = 30.2424   # 北纬
LON = 120.1431  # 东经
ALT = 12.5


def dms(value):
    """十进制角度 -> (度, 分, 秒)，用 IFDRational 表示有理数。"""
    deg = int(value)
    minute_float = (value - deg) * 60
    minute = int(minute_float)
    second = round((minute_float - minute) * 60, 2)
    return (
        IFDRational(deg, 1),
        IFDRational(minute, 1),
        IFDRational(int(second * 100), 100),
    )


def paint():
    """画一张简单的风景图，作为示例照片的内容。"""
    w, h = 640, 420
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / h
        # 天空：浅蓝到暖白渐变
        px_color = (
            int(120 + 100 * t),
            int(170 + 65 * t),
            int(220 - 25 * t),
        )
        for x in range(w):
            px[x, y] = px_color

    d = ImageDraw.Draw(img)
    # 太阳
    d.ellipse((470, 55, 540, 125), fill=(255, 236, 170))
    # 远山
    d.polygon([(0, 255), (110, 165), (210, 240), (320, 150),
               (430, 235), (540, 175), (640, 250), (640, 290), (0, 290)],
              fill=(96, 128, 120))
    # 湖面
    d.rectangle((0, 270, w, h), fill=(70, 132, 158))
    for i in range(14):
        y = 285 + i * 10
        d.line((40 + i * 7, y, 600 - i * 9, y), fill=(120, 175, 190), width=2)
    # 说明文字（默认字体，避免依赖系统中文字体）
    d.text((18, 18), "SAMPLE PHOTO - EXIF GPS DEMO", fill=(30, 50, 70))
    d.text((18, 36), PLACE, fill=(30, 50, 70))
    d.text((18, h - 26), f"GPS  {abs(LAT):.4f} N   {abs(LON):.4f} E",
           fill=(235, 245, 250))
    return img


def write_exif(img):
    exif = Image.Exif()
    exif[0x010F] = "WorkBuddy"               # Make
    exif[0x0110] = "EXIF GPS Sample"         # Model
    exif[0x0132] = "2026:11:06 15:30:00"    # DateTime

    exif_ifd = exif.get_ifd(0x8769)
    exif_ifd[0x9003] = "2026:11:06 15:30:00"  # DateTimeOriginal

    gps = exif.get_ifd(0x8825)
    gps[1] = "N" if LAT >= 0 else "S"        # GPSLatitudeRef
    gps[2] = dms(abs(LAT))                  # GPSLatitude
    gps[3] = "E" if LON >= 0 else "W"        # GPSLongitudeRef
    gps[4] = dms(abs(LON))                  # GPSLongitude
    gps[5] = 0                              # GPSAltitudeRef (above sea level)
    gps[6] = IFDRational(int(ALT * 10), 10) # GPSAltitude
    return exif


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img = paint()
    img.save(OUT, "JPEG", quality=88, exif=write_exif(img))
    print(f"written: {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
