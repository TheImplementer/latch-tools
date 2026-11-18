# A bank-statement-like Word document. Targets in red (cf1, or cf4 on navy),
# labels in blue (cf2), everything else black/white. Built to hit the layout
# features Word users actually produce: tabs, justified wrap, bold inside a
# name, underlined links, small caps, letter spacing, tables with shading,
# a header, two columns, several fonts and sizes.
import sys
R = lambda s: r"{\cf1 " + s + "}"
B = lambda s: r"{\cf2 " + s + "}"
filler = ("We are writing to confirm the details of the current account we hold for you. "
          "Please read this statement carefully and keep it somewhere safe, because it "
          "contains information that could be used to identify you. ")
doc = r"""{\rtf1\ansi\deff0
{\fonttbl{\f0 Calibri;}{\f1 Times New Roman;}{\f2 Arial;}{\f3 Cambria;}{\f4 Courier New;}{\f5 Georgia;}{\f6 Aptos;}}
{\colortbl;\red238\green26\blue26;\red26\green51\blue204;\red20\green30\blue70;\red255\green97\blue97;\red255\green255\blue255;\red232\green234\blue238;}
\paperw11906\paperh16838\margl1134\margr1134\margt1134\margb1134
{\header \pard\qr\f2\fs16 """ + B("Account") + " " + R("41234567") + r""" \par}
\pard\f3\fs36 Northwind Bank plc\par
\pard\f2\fs20\expnd30\expndtw30 """ + B("ACCOUNT HOLDER:") + " " + R("JANE EXAMPLE") + r"""\expnd0\expndtw0\par
\pard\sa120\f0\fs22\tx1800\tx3600\tx5400 """ + B("Sort code:") + r"\tab " + R("20-45-67") + r"\tab " + B("Account number:") + r"\tab " + R("41234567") + r"""\par
\pard\qj\sa120\f0\fs22 """ + filler + "Dear " + R("Jane") + " " + r"{\cf1\b Example}" + ", " + filler + "The account is in the name of " + R("Jane Example") + " and statements go to " + R("Jane Example") + " only. " + filler + "Contact " + R("Jane Example") + r""" if anything here looks wrong.\par
\pard\sa120\f0\fs22 """ + B("Email") + " " + r'{\field{\*\fldinst HYPERLINK "mailto:jane.example@example.co.uk"}{\fldrslt{\cf1\ul jane.example@example.co.uk}}}' + " " + B("or call") + r" {\f1\fs24\cf1 +44 20 7946 0958}" + r""".\par
\pard\sa120\f5\fs22 """ + B("National Insurance:") + " " + R("AB 12 34 56 C") + " " + B("Name in small caps:") + r" {\scaps\cf1 Jane Example}" + r"""\par
\pard\sa60\f4\fs20 """ + B("IBAN") + " " + R("GB33 BUKB 2045 6741 2345 67") + r"""\par
\pard\sa120\par
\trowd\trgaph100\trleft0
\clcbpat6\cellx2000\clcbpat6\cellx7000\clcbpat6\cellx8400\clcbpat6\cellx9600
\pard\intbl\f3\fs20\b Date\cell Description\cell\qr Out\cell\qr Balance\cell\b0\row
\trowd\trgaph100\trleft0\cellx2000\cellx7000\cellx8400\cellx9600
\pard\intbl\f3\fs20 01-10-24\cell Card payment """ + R("4111 1111 1111 1111") + r""" TESCO 2231\cell\qr 45.20\cell\qr 1,204.80\cell\row
\trowd\trgaph100\trleft0\clcbpat6\cellx2000\clcbpat6\cellx7000\clcbpat6\cellx8400\clcbpat6\cellx9600
\pard\intbl\f3\fs20 02-10-24\cell Transfer to """ + R("40-11-22") + " " + R("87654321") + r"""\cell\qr 300.00\cell\qr 904.80\cell\row
\trowd\trgaph100\trleft0\clcbpat3\cellx2000\clcbpat3\cellx7000\clcbpat3\cellx8400\clcbpat3\cellx9600
\pard\intbl\f3\fs20\cf5 03-10-24\cell Refund to {\cf4 Jane Example}\cf5\cell\qr\cell\qr 3,354.80\cell\cf0\row
\trowd\trgaph100\trleft0\cellx2000\cellx7000\cellx8400\cellx9600
\pard\intbl\f3\fs20 04-10-24\cell Reference 20241003 SALARY ACME LTD\cell\qr\cell\qr 3,354.80\cell\row
\pard\sa120\par
\sect\sbknone\cols2\colsx567
\pard\qj\f6\fs20 """ + (filler * 2) + "Payee " + R("Jane Example") + ", sort code " + R("20-45-67") + ". " + (filler * 2) + r"""\par
\sect\sbknone\cols1
\pard\f0\fs56\b Office file for """ + R("Jane Example") + r"""\b0\par
\pard\f2\fs8 Small print: """ + R("Jane Example") + " " + R("41234567") + r"""\par
\pard\f0\fs22 """ + R("KEEP-THIS-RED") + r"""\par
}"""
open(sys.argv[1], "w").write(doc)
