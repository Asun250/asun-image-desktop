// Windows branding for Asun's browser app windows, never the shared browser process.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AsunIMG {
 [StructLayout(LayoutKind.Sequential, Pack=4)] public struct PropertyKey {
  public Guid Format; public uint Id;
  public PropertyKey(uint id) { Format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); Id=id; }
 }
 // PROPVARIANT: its pointer/value union begins at offset8 on both Windows ABIs.
 [StructLayout(LayoutKind.Explicit, Size=24)] public struct PropVariant {
  [FieldOffset(0)] public ushort Type;
  [FieldOffset(8)] public IntPtr Pointer;
 }
 [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 public interface PropertyStore {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index,out PropertyKey key);
  [PreserveSig] int GetValue(ref PropertyKey key,out PropVariant value);
  [PreserveSig] int SetValue(ref PropertyKey key,ref PropVariant value);
  [PreserveSig] int Commit();
 }
 [StructLayout(LayoutKind.Sequential)] public struct IconInfo {
  [MarshalAs(UnmanagedType.Bool)] public bool IsIcon;
  public uint XHotspot,YHotspot; public IntPtr Mask,Color;
 }
 public sealed class WindowInfo {
  public long Handle; public int ProcessId; public string Title,ClassName,ProcessName;
  public string AppId,IconResource,RelaunchCommand,DisplayName;
  public long SmallIcon,LargeIcon; public bool SmallIconValid,LargeIconValid;
 }
 public static class WindowBrand {
  public const string AppId="Asun.IMG";
  private delegate bool EnumCallback(IntPtr h,IntPtr p);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback,IntPtr param);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h,StringBuilder s,int max);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h,StringBuilder s,int max);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr SendMessageTimeout(IntPtr h,uint msg,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr LoadImage(IntPtr instance,string name,uint type,int w,int h,uint flags);
  [DllImport("user32.dll")] private static extern bool GetIconInfo(IntPtr icon,out IconInfo info);
  [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
  [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] private static extern int GetSystemMetricsForDpi(int index,uint dpi);
  [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr h);
  [DllImport("shell32.dll")] private static extern int SHGetPropertyStoreForWindow(IntPtr h,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out PropertyStore store);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)] private static extern int SHGetPropertyStoreFromParsingName(string path,IntPtr bind,uint flags,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out PropertyStore store);
  [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);
  private static readonly Guid StoreId=new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
  private static readonly Dictionary<int,IntPtr> Icons=new Dictionary<int,IntPtr>();
  private static string IconFile;

  public static bool IsAsun(string title,string className,string process) {
   return (process=="msedge" || process=="chrome") && className=="Chrome_WidgetWin_1" &&
    (title=="Asun IMG" || title.EndsWith("\u2014 Asun IMG",StringComparison.Ordinal) ||
     title.EndsWith("\u2014 Asun image",StringComparison.Ordinal));
  }
  public static bool Matches(IntPtr h) {
   if(!IsWindow(h)||!IsWindowVisible(h)) return false;
   StringBuilder title=new StringBuilder(1024),cls=new StringBuilder(256);
   GetWindowText(h,title,title.Capacity); GetClassName(h,cls,cls.Capacity);
   uint pid; GetWindowThreadProcessId(h,out pid);
   try { using(Process p=Process.GetProcessById((int)pid)) return IsAsun(title.ToString(),cls.ToString(),p.ProcessName); }
   catch(ArgumentException) { return false; }
  }
  public static long[] Windows() {
   List<long> found=new List<long>();
   EnumWindows(delegate(IntPtr h,IntPtr p) { if(Matches(h)) found.Add(h.ToInt64()); return true; },IntPtr.Zero);
   return found.ToArray();
  }
  public static bool Alive(long handle) { return IsWindow(new IntPtr(handle)); }
  private static PropertyStore WindowStore(IntPtr h) {
   Guid iid=StoreId; PropertyStore store;
   Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(h,ref iid,out store)); return store;
  }
  private static string Get(PropertyStore store,uint id) {
   PropertyKey key=new PropertyKey(id); PropVariant value;
   Marshal.ThrowExceptionForHR(store.GetValue(ref key,out value));
   try { return value.Type==31 ? Marshal.PtrToStringUni(value.Pointer) : null; }
   finally { PropVariantClear(ref value); }
  }
  private static void Set(PropertyStore store,uint id,string text) {
   PropertyKey key=new PropertyKey(id); PropVariant value=new PropVariant();
   value.Type=31; value.Pointer=Marshal.StringToCoTaskMemUni(text);
   try { Marshal.ThrowExceptionForHR(store.SetValue(ref key,ref value)); }
   finally { PropVariantClear(ref value); }
  }
  private static IntPtr Message(IntPtr h,uint msg,int kind,IntPtr value) {
   IntPtr result;
   if(SendMessageTimeout(h,msg,new IntPtr(kind),value,2,1000,out result)==IntPtr.Zero)
    throw new InvalidOperationException("Asun window did not answer its icon message.");
   return result;
  }
  public static bool ValidIcon(long handle) {
   if(handle==0) return false; IconInfo info;
   if(!GetIconInfo(new IntPtr(handle),out info)) return false;
   if(info.Color!=IntPtr.Zero) DeleteObject(info.Color);
   if(info.Mask!=IntPtr.Zero) DeleteObject(info.Mask);
   return info.IsIcon;
  }
  public static WindowInfo Inspect(long handle) {
   IntPtr h=new IntPtr(handle); if(!IsWindow(h)) throw new ArgumentException("Window no longer exists.");
   StringBuilder title=new StringBuilder(1024),cls=new StringBuilder(256);
   GetWindowText(h,title,title.Capacity); GetClassName(h,cls,cls.Capacity);
   uint pid; GetWindowThreadProcessId(h,out pid);
   WindowInfo info=new WindowInfo(); info.Handle=handle; info.ProcessId=(int)pid;
   info.Title=title.ToString(); info.ClassName=cls.ToString();
   using(Process process=Process.GetProcessById((int)pid)) info.ProcessName=process.ProcessName;
   PropertyStore store=WindowStore(h);
   try { info.AppId=Get(store,5); info.IconResource=Get(store,3); info.RelaunchCommand=Get(store,2); info.DisplayName=Get(store,4); }
   finally { Marshal.ReleaseComObject(store); }
   info.SmallIcon=Message(h,0x7F,0,IntPtr.Zero).ToInt64(); info.LargeIcon=Message(h,0x7F,1,IntPtr.Zero).ToInt64();
   info.SmallIconValid=ValidIcon(info.SmallIcon); info.LargeIconValid=ValidIcon(info.LargeIcon);
   return info;
  }
  private static IntPtr Icon(string file,int size) {
   if(IconFile!=null && IconFile!=file) throw new InvalidOperationException("One helper owns one immutable icon file.");
   IconFile=file; IntPtr icon;
   if(!Icons.TryGetValue(size,out icon)) {
    icon=LoadImage(IntPtr.Zero,file,1,size,size,0x10);
    if(icon==IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Cannot load the Asun husky icon.");
    Icons.Add(size,icon);
   }
   return icon;
  }
  public static bool Apply(long handle,string iconFile,string launchCommand) {
   IntPtr h=new IntPtr(handle); if(!Matches(h)) return false; // Recheck ownership before each mutation.
   PropertyStore store=WindowStore(h); bool changed=false;
   try {
    string resource=Path.GetFullPath(iconFile)+",0";
    // Supply all relaunch metadata before assigning the stable window ID.
    if(Get(store,3)!=resource) { Set(store,3,resource); changed=true; }
    if(Get(store,2)!=launchCommand) { Set(store,2,launchCommand); changed=true; }
    if(Get(store,4)!="Asun IMG") { Set(store,4,"Asun IMG"); changed=true; }
    if(changed || Get(store,5)!=AppId) { Set(store,5,AppId); changed=true; }
    // Window property stores apply immediately; Commit is intentionally unnecessary.
   } finally { Marshal.ReleaseComObject(store); }
   uint dpi=GetDpiForWindow(h); if(dpi==0) dpi=96;
   IntPtr small=Icon(iconFile,GetSystemMetricsForDpi(49,dpi)),big=Icon(iconFile,GetSystemMetricsForDpi(11,dpi));
   if(Message(h,0x7F,0,IntPtr.Zero)!=small) { Message(h,0x80,0,small); changed=true; }
   if(Message(h,0x7F,1,IntPtr.Zero)!=big) { Message(h,0x80,1,big); changed=true; }
   return changed;
  }
  public static string ShortcutId(string path) {
   Guid iid=StoreId; PropertyStore store;
   Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path,IntPtr.Zero,0,ref iid,out store));
   try { return Get(store,5); } finally { Marshal.ReleaseComObject(store); }
  }
  public static void SetShortcutId(string path) {
   Guid iid=StoreId; PropertyStore store;
   Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path,IntPtr.Zero,2,ref iid,out store));
   try { Set(store,5,AppId); Marshal.ThrowExceptionForHR(store.Commit()); }
   finally { Marshal.ReleaseComObject(store); }
  }
  // Call only after all managed Asun windows are gone. Never destroy browser-owned old icons.
  public static void Release() { foreach(IntPtr icon in Icons.Values) DestroyIcon(icon); Icons.Clear(); IconFile=null; }
 }
}
