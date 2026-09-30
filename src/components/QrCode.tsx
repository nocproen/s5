import QRCode from "qrcode";

export async function QrCode({ value, size = 160 }: { value: string; size?: number }) {
  const dataUrl = await QRCode.toDataURL(value, {
    width: size,
    margin: 1,
    color: { dark: "#0b1020", light: "#ffffff" },
    errorCorrectionLevel: "M",
  });
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dataUrl}
      width={size}
      height={size}
      alt="二维码"
      className="rounded-lg bg-white p-1"
    />
  );
}
