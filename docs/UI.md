# Ngôn ngữ thiết kế

Tham chiếu: **TablePlus** cho ngôn ngữ thị giác (vật liệu kính, badge chữ, hàng
bo góc, accent hệ thống) và **Termius** cho kiến trúc thông tin (nav rail bên
trái, Groups + Hosts dạng lưới card, ô tìm kiếm có nút Connect).

Đây là app chrome cho công cụ chuyên nghiệp, không phải landing page. Mật độ
giữ ở mức pro-tool, chuyển động gần như không có: terminal đang vẽ 60fps, mọi
animation thừa đều ăn frame của nó.

## Cấu trúc

```
┌──────────────┬─────────────────────────────────────────────┐
│ nav rail     │ tabstrip: [Quản lý] [session] [session] …   │
│              ├─────────────────────────────────────────────┤
│ Hosts        │                                             │
│ Keychain     │  màn Quản lý:  Groups (card)                │
│ Snippets     │                Hosts  (card)                │
│ Known hosts  │                                             │
│              │  hoặc màn session: panes + terminal / SFTP  │
│ Import       │                                             │
│ Chủ đề       │                                             │
└──────────────┴─────────────────────────────────────────────┘
```

Nav rail là **đích đến**, không phải nút mở dialog. Keychain, Snippets, Known
hosts đều là màn riêng. Chỉ Port forwarding còn là modal vì nó gắn với một
session đang mở, không tồn tại độc lập.

## Token

Toàn bộ ở [`src/styles/tokens.css`](../src/styles/tokens.css). Ba khoá bị lock
để UI không trôi:

- **Một accent duy nhất.** Teal cho hành động chính, xanh hệ thống cho lựa
  chọn. Không có section nào tự đổi accent.
- **Ba bậc bán kính, có quy tắc.** `7px` cho control, `12px` cho panel/card,
  `16px` cho dialog.
- **Một chủ đề cho cả trang.** Sáng, tối, hoặc theo hệ điều hành (mặc định).
  Không có vùng nào đảo màu giữa trang.

## Về "liquid glass"

Cần nói rõ: **Apple chỉ định nghĩa Liquid Glass cho nền tảng Apple, không có
package CSS chính thức nào.** Thứ trong Shellmux là *xấp xỉ bằng CSS*: nền
gradient + `backdrop-filter` + viền sáng ở mép.

Giới hạn thật của cách này: `backdrop-filter` chỉ làm mờ những gì nằm **trong**
cửa sổ app. Nó không mờ được desktop phía sau như TablePlus. Muốn vibrancy thật
thì phải xuống tầng native:

1. `"macOSPrivateApi": true` trong `tauri.conf.json`
2. cửa sổ trong suốt + `NSVisualEffectView` qua crate `window-vibrancy`
3. token `--glass` hạ alpha để lớp native lộ qua

Chưa làm vì nó thêm một dependency trực tiếp và chỉ đúng trên macOS. Xấp xỉ
CSS đã cho đúng cảm giác vật liệu ở cả ba nền tảng.

Người dùng bật *Reduce transparency* trong Accessibility thì token tự chuyển
sang nền đặc, không blur.

## Quy ước không được vi phạm

- **Không emoji làm icon.** Emoji render khác nhau theo OS, không điều khiển
  được nét. Thay bằng nhãn chữ, hoặc badge 2 ký tự như TablePlus dùng cho loại
  kết nối (`Re`, `Pg`). Màu badge suy ra từ id nên mỗi host giữ đúng một màu.
- **Không tự vẽ SVG icon.** Nếu sau này cần icon thật thì cài một thư viện
  (Phosphor, Tabler), đừng vẽ path tay.
- **Không dùng `window.prompt` / `window.confirm`.** Dialog hệ điều hành chặn
  cả process và không style được. Dùng `useDialog().ask()` / `.confirm()` —
  vẫn trả Promise nên call site gần như không đổi, mà có Esc, Enter, autofocus.
- **Không em-dash trong chuỗi hiển thị.** Dùng dấu gạch ngang thường, dấu phẩy,
  hoặc tách câu.
- **Mọi trạng thái đều phải có.** Rỗng, đang tải (skeleton theo hình dáng nội
  dung thật, không phải spinner tròn), lỗi. Không chỉ vẽ trạng thái thành công.
- **Focus phải thấy được.** `:focus-visible` có ring ở mọi control.

## Xem thử layout khi vault trống

Ở chế độ dev, store được expose ra console để soi lưới card mà không cần host
thật:

```js
__vault.setState({ ready: true, groups: [...], hosts: [...] })
```

Khối này nằm sau `import.meta.env.DEV` nên không có trong bản build.
